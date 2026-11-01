import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ForgeError, MAX_REVISION, newId, sha256, type QueryFilter } from "@forge/core";
import { canonicalJobJson, JOB_APP_GRANT_SCHEMA, JOB_CREATE_SCHEMA, JOB_IDEMPOTENCY_KEY_SCHEMA, JOB_INVOKE_SCHEMA, JOB_MANIFEST_SCHEMA, JOB_PATCH_SCHEMA, type JobCreate, type JobJson, type JobManifest, type JobPatch } from "@forge/contracts";
import { one, query, transaction } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
import { boundPageCursor, readBoundPageCursor } from "../pagination.js";
import { auditRepo } from "./audit.js";

export interface JobDefinitionRow extends RowDataPacket {
  id: string; key: string; name: string; description: string; business_type: string; owner_org_unit_id: string | null;
  created_by: string | null; responsible_user_id: string | null; revision: number; status: "active" | "disabled" | "deleted";
  draft_json: JobManifest; published_version_id: string | null; next_version: number; created_at: Date; updated_at: Date;
}
export interface JobVersionRow extends RowDataPacket {
  id: string; job_id: string; version: number; manifest_json: JobManifest; manifest_hash: string; policy_json: JobJson; input_schema_json: JobJson; output_schema_json: JobJson;
}
export interface JobExecutionRow extends RowDataPacket {
  id: string; job_id: string; job_version_id: string; input_hash: string; business_key_hash: string; round: number; generation: number;
  state_revision: number; status: string; wait_reason: string | null; requested_action: string | null; next_event_seq: string; fence_token: string;
  owner_org_unit_id: string | null; input_json: JobJson; snapshot_json: JobJson; subject_type: string; subject_id: string; app_id: string | null; created_at: Date;
}
export interface JobWrite {
  actor: { type: "user" | "service" | "app"; id: string };
  /** Re-read the current actor and enforce function, references and data-policy ceilings inside this transaction. */
  authorize: (connection: PoolConnection, job: JobDefinitionRow | null) => Promise<void>;
}
function invalid(message: string): ForgeError { return new ForgeError("CFG-8501", { message }); }
function conflict(): ForgeError { return new ForgeError("JOB-7106"); }
function assertRevision(actual: number, expected: number): void {
  if (!Number.isInteger(expected) || actual !== expected || actual >= MAX_REVISION) throw conflict();
}
async function definition(id: string, filter: QueryFilter, conn?: PoolConnection, lock = false): Promise<JobDefinitionRow | null> {
  const access = jobFilterSql(filter, "definition");
  return one<JobDefinitionRow>(`SELECT d.* FROM job_definitions d WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${lock ? " FOR UPDATE" : ""}`, [id, ...access.params], conn);
}
async function execution(id: string, filter: QueryFilter, conn?: PoolConnection): Promise<JobExecutionRow | null> {
  const access = jobFilterSql(filter, "execution");
  return one<JobExecutionRow>(`SELECT e.*,CAST(e.next_event_seq AS CHAR) AS next_event_seq,CAST(e.fence_token AS CHAR) AS fence_token FROM job_executions e WHERE e.id=? AND ${access.sql}`, [id, ...access.params], conn);
}
async function audit(conn: PoolConnection, options: JobWrite, job: JobDefinitionRow, action: string, resourceId = job.id, details: JobJson = {}): Promise<void> {
  await auditRepo.audit({ actorType: options.actor.type, actorId: options.actor.id, action, resourceType: action === "job.execute" ? "job_execution" : "job_definition", resourceId, orgUnitId: job.owner_org_unit_id, details }, conn);
}
function parse<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw invalid("任务输入不符合约定");
  return result.data;
}

export const jobsRepo = {
  getJob: definition,
  async manageableJobIds(ids: string[], filter: QueryFilter): Promise<string[]> {
    if (!ids.length) return [];
    const access=jobFilterSql(filter,"definition");
    return (await query<{id:string}>(`SELECT d.id FROM job_definitions d WHERE d.id IN (${ids.map(()=>"?").join(",")}) AND d.status<>'deleted' AND ${access.sql}`,[...ids,...access.params])).map(row=>row.id);
  },
  getJobExecution: execution,
  async listJobs(filter: QueryFilter, input: { status?: string; businessType?: string; orgUnitId?: string; limit?: number; cursor?: string } = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("分页数量无效");
    const context = sha256(JSON.stringify({ filter, status: input.status ?? null, businessType: input.businessType ?? null, orgUnitId: input.orgUnitId ?? null }));
    const cursor = readBoundPageCursor(input.cursor, context), access = jobFilterSql(filter, "definition");
    const clauses = ["d.status<>'deleted'", access.sql], params: unknown[] = [...access.params];
    if (input.status !== undefined) { clauses.push("d.status=?"); params.push(input.status); }
    if (input.orgUnitId !== undefined) { clauses.push("d.owner_org_unit_id=?"); params.push(input.orgUnitId); }
    if (input.businessType !== undefined) { clauses.push("d.business_type=?"); params.push(input.businessType); }
    if (cursor) { clauses.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))"); params.push(new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id); }
    const rows = await query<JobDefinitionRow>(`SELECT d.* FROM job_definitions d WHERE ${clauses.map(clause => `(${clause})`).join(" AND ")} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`, [...params, limit + 1]);
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }, context) : null };
  },
  async listJobVersions(jobId: string, filter: QueryFilter, input: { limit?: number; cursor?: string } = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("分页数量无效");
    const context = sha256(JSON.stringify({ filter, jobId, kind: "versions" })), cursor = readBoundPageCursor(input.cursor, context), access = jobFilterSql(filter, "definition");
    const rows = await query<JobVersionRow & { created_at: Date }>(`SELECT v.id,v.job_id,v.version,v.manifest_hash,v.created_at FROM job_definition_versions v JOIN job_definitions d ON d.id=v.job_id WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${cursor ? " AND (v.created_at < ? OR (v.created_at = ? AND v.id < ?))" : ""} ORDER BY v.created_at DESC,v.id DESC LIMIT ?`, [jobId, ...access.params, ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
  },
  async createJob(raw: JobCreate, filter: QueryFilter, options: JobWrite): Promise<JobDefinitionRow> {
    const input = parse(JOB_CREATE_SCHEMA.safeParse(raw));
    if (input.status !== "disabled") throw invalid("发布可运行版本后才能启用任务");
    return transaction(async conn => {
      await options.authorize(conn, null);
      const id = newId();
      await conn.execute("INSERT INTO job_definitions (id,`key`,name,description,business_type,owner_org_unit_id,created_by,responsible_user_id,draft_json) VALUES (?,?,?,?,?,?,?,?,?)", [id, input.key, input.name, input.description, input.businessType, input.orgUnitId ?? null, options.actor.type === "user" ? options.actor.id : null, input.responsibleUserId ?? null, canonicalJobJson(input.draft)]);
      const row = await definition(id, filter, conn);
      if (!row) throw new ForgeError("JOB-7101");
      await audit(conn, options, row, "job.create");
      return row;
    }, "READ COMMITTED");
  },
  async updateJob(id: string, raw: JobPatch, expectedRevision: number, filter: QueryFilter, options: JobWrite): Promise<JobDefinitionRow> {
    const input = parse(JOB_PATCH_SCHEMA.safeParse(raw));
    return transaction(async conn => {
      const row = await definition(id, filter, conn, true);
      if (!row) throw new ForgeError("JOB-7101");
      await options.authorize(conn, row);
      assertRevision(row.revision, expectedRevision);
      if (row.published_version_id && ((input.businessType !== undefined && input.businessType !== row.business_type) || (input.orgUnitId !== undefined && input.orgUnitId !== row.owner_org_unit_id))) throw invalid("发布后不能修改任务业务类型或组织");
      if (input.status === "active" && !row.published_version_id) throw invalid("请先发布可运行版本");
      const fields: Record<string, unknown> = { name: input.name, description: input.description, business_type: input.businessType, owner_org_unit_id: input.orgUnitId, responsible_user_id: input.responsibleUserId, status: input.status, draft_json: input.draft ? canonicalJobJson(input.draft) : undefined };
      const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
      if (entries.length) await conn.execute(`UPDATE job_definitions SET ${entries.map(([key]) => `\`${key}\`=?`).join(",")},revision=revision+1 WHERE id=?`, [...entries.map(([, value]) => value), id] as never[]);
      const updated = await definition(id, filter, conn);
      if (!updated) throw new ForgeError("JOB-7101");
      await audit(conn, options, row, "job.update");
      return updated;
    }, "READ COMMITTED");
  },
  async publishJob(id: string, expectedRevision: number, filter: QueryFilter, options: JobWrite, validate: (manifest: JobManifest, conn: PoolConnection) => Promise<void>): Promise<{ versionId: string; version: number; revision: number; manifestHash: string }> {
    return transaction(async conn => {
      const row = await definition(id, filter, conn, true);
      if (!row) throw new ForgeError("JOB-7101");
      await options.authorize(conn, row); assertRevision(row.revision, expectedRevision);
      const manifest = parse(JOB_MANIFEST_SCHEMA.safeParse(row.draft_json));
      await validate(manifest, conn);
      if (row.next_version >= MAX_REVISION) throw conflict();
      const body = canonicalJobJson(manifest), hash = sha256(body), versionId = newId();
      await conn.execute("INSERT INTO job_definition_versions (id,job_id,version,manifest_json,manifest_hash,policy_json,input_schema_json,output_schema_json,published_by) VALUES (?,?,?,?,?,?,?,?,?)", [versionId, id, row.next_version, body, hash, canonicalJobJson(manifest.limits), canonicalJobJson(manifest.inputSchema), canonicalJobJson(manifest.outputSchema), options.actor.type === "user" ? options.actor.id : null]);
      await conn.execute("UPDATE job_definitions SET published_version_id=?,next_version=next_version+1,revision=revision+1 WHERE id=?", [versionId, id]);
      await audit(conn, options, row, "job.publish", id, { versionId, manifestHash: hash });
      return { versionId, version: row.next_version, revision: row.revision + 1, manifestHash: hash };
    }, "READ COMMITTED");
  },
  async deleteJob(id: string, expectedRevision: number, filter: QueryFilter, options: JobWrite): Promise<void> {
    await transaction(async conn => {
      const row = await definition(id, filter, conn, true);
      if (!row) throw new ForgeError("JOB-7101");
      await options.authorize(conn, row); assertRevision(row.revision, expectedRevision);
      const used = await one<{ count: number }>("SELECT (SELECT COUNT(*) FROM job_definition_versions WHERE job_id=?) + (SELECT COUNT(*) FROM job_executions WHERE job_id=?) + (SELECT COUNT(*) FROM job_app_grants WHERE job_id=?) AS count", [id, id, id], conn);
      if (Number(used?.count)) throw new ForgeError("JOB-7102", { message: "任务仍被版本、执行或应用授权引用" });
      await conn.execute("UPDATE job_definitions SET status='deleted',revision=revision+1 WHERE id=?", [id]);
      await audit(conn, options, row, "job.delete");
    }, "READ COMMITTED");
  },
  async getJobVersion(jobId: string, versionId: string, filter: QueryFilter): Promise<JobVersionRow | null> {
    const access = jobFilterSql(filter, "definition");
    return one<JobVersionRow>(`SELECT v.* FROM job_definition_versions v JOIN job_definitions d ON d.id=v.job_id WHERE d.id=? AND v.id=? AND d.status<>'deleted' AND ${access.sql}`, [jobId, versionId, ...access.params]);
  },
  async setJobAppGrant(jobId: string, appId: string, raw: unknown, expectedRevision: number, filter: QueryFilter, options: JobWrite, validateApp: (connection: PoolConnection, appId: string, actions: string[]) => Promise<void>): Promise<number> {
    const input = parse(JOB_APP_GRANT_SCHEMA.safeParse(raw));
    if (input.appId !== appId) throw invalid("应用ID与路径不一致");
    return transaction(async conn => {
      const row = await definition(jobId, filter, conn, true);
      if (!row) throw new ForgeError("JOB-7101");
      await options.authorize(conn, row); assertRevision(row.revision, expectedRevision);
      await validateApp(conn, appId, input.actions);
      const current = await one<{ revision: number }>("SELECT revision FROM job_app_grants WHERE job_id=? AND app_id=? FOR UPDATE", [jobId, appId], conn);
      if (current && current.revision >= MAX_REVISION) throw conflict();
      await conn.execute("INSERT INTO job_app_grants (id,job_id,app_id,actions_json,status,created_by) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE actions_json=VALUES(actions_json),status=VALUES(status),revision=revision+1", [newId(), jobId, appId, canonicalJobJson(input.actions), input.status, options.actor.type === "user" ? options.actor.id : null]);
      await conn.execute("UPDATE job_definitions SET revision=revision+1 WHERE id=?", [jobId]);
      await audit(conn, options, row, "job.grant", jobId, { appId, actions: input.actions, status: input.status });
      return row.revision + 1;
    }, "READ COMMITTED");
  },
  async admitJob(input: {
    jobId: string; invoke: unknown; businessKeyHash: string; idempotencyKey: string;
    executionFilter: QueryFilter; definitionFilter: QueryFilter;
    runtimeEngine: "mysql-agent-bridge" | "temporal-job-v1"; snapshot: JobJson;
    triggerType: "manual" | "schedule" | "api" | "evaluation"; triggerRef?: string;
    initialSteps: { key: string; itemKey: string; kind: string; input: JobJson; readOnly: boolean }[];
    validate: (job: JobDefinitionRow, version: JobVersionRow, connection: PoolConnection) => Promise<void>;
  }, options: JobWrite): Promise<{ executionId: string; replayed: boolean }> {
    const invoke = parse(JOB_INVOKE_SCHEMA.safeParse(input.invoke));
    const key = sha256(parse(JOB_IDEMPOTENCY_KEY_SCHEMA.safeParse(input.idempotencyKey)));
    if (!/^[a-f0-9]{64}$/.test(input.businessKeyHash)) throw invalid("受理上下文无效");
    if (input.initialSteps.length < 1 || input.initialSteps.length > 128) throw new ForgeError("JOB-7110");
    const scope = sha256(JSON.stringify(["job.execute", options.actor.type, options.actor.id, input.jobId]));
    const requestHash = sha256(canonicalJobJson(invoke)), inputHash = sha256(canonicalJobJson({ input: invoke.input, businessRef: invoke.businessRef, ...(invoke.items ? { items: invoke.items } : {}) }));
    return transaction(async conn => {
      const job = await definition(input.jobId, input.definitionFilter, conn, true);
      if (!job) throw new ForgeError("JOB-7101");
      await options.authorize(conn, job);
      const [cached] = await conn.query<RowDataPacket[]>("SELECT request_hash,response_json,expires_at FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE", [scope, key]);
      if (cached[0]) {
        if (cached[0].request_hash !== requestHash) throw new ForgeError("OPN-4503");
        const existingId = String(cached[0].response_json.executionId);
        if (!await execution(existingId, input.executionFilter, conn)) throw new ForgeError("JOB-7101");
        return { executionId: existingId, replayed: true };
      }
      const existing = await one<{ id: string; input_hash: string }>("SELECT id,input_hash FROM job_executions WHERE job_id=? AND business_key_hash=? ORDER BY round DESC LIMIT 1 FOR UPDATE", [job.id, input.businessKeyHash], conn);
      if (existing) {
        if (existing.input_hash !== inputHash || !await execution(existing.id, input.executionFilter, conn)) throw new ForgeError("JOB-7103");
        await remember(conn, scope, key, requestHash, existing.id);
        return { executionId: existing.id, replayed: true };
      }
      const versionId = invoke.versionId ?? job.published_version_id;
      const version = versionId ? await one<JobVersionRow>("SELECT * FROM job_definition_versions WHERE id=? AND job_id=?", [versionId, job.id], conn) : null;
      if (job.status !== "active" || !version) throw new ForgeError("JOB-7102");
      await input.validate(job, version, conn);
      const queued = await one<{ count: number }>("SELECT COUNT(*) AS count FROM job_executions WHERE job_id=? AND status='queued' AND started_at IS NULL", [job.id], conn);
      if (Number(queued?.count) >= 50) throw new ForgeError("JOB-7105");
      const id = newId(), manifest = parse(JOB_MANIFEST_SCHEMA.safeParse(version.manifest_json));
      await conn.execute(`INSERT INTO job_executions (id,job_id,job_version_id,owner_org_unit_id,subject_type,subject_id,app_id,trigger_type,trigger_ref,trigger_actor_json,business_type,business_object_id,business_period,business_ref_json,business_key_hash,input_hash,runtime_engine,snapshot_quality,input_json,snapshot_json,total_count,active_budget_seconds,cost_limit_usd,next_event_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,2)`, [id, job.id, version.id, job.owner_org_unit_id, options.actor.type, options.actor.id, options.actor.type === "app" ? options.actor.id : null, input.triggerType, input.triggerRef ?? null, canonicalJobJson(options.actor), invoke.businessRef.type, invoke.businessRef.id, invoke.businessRef.period ?? null, canonicalJobJson(invoke.businessRef), input.businessKeyHash, inputHash, input.runtimeEngine, input.runtimeEngine === "mysql-agent-bridge" ? "legacy" : "frozen", canonicalJobJson(invoke), canonicalJobJson(input.snapshot), invoke.items?.length ?? 1, manifest.limits.activeTimeoutSeconds, manifest.limits.maxCostUsd]);
      for (const step of input.initialSteps) await conn.execute("INSERT INTO job_steps (id,execution_id,step_key,item_key,item_hash,kind,status,depends_on_json,input_hash,input_json,read_only,available_at) VALUES (?,?,?,?,?,?,'ready','[]',?,?,?,UTC_TIMESTAMP(3))", [newId(), id, step.key, step.itemKey, sha256(step.itemKey), step.kind, sha256(canonicalJobJson(step.input)), canonicalJobJson(step.input), step.readOnly ? 1 : 0]);
      const eventId = newId();
      await conn.execute("INSERT INTO job_events (execution_id,seq,event_id,generation,type,data_json) VALUES (?,1,?,1,'job.queued',?)", [id, eventId, canonicalJobJson({ executionId: id })]);
      await conn.execute("INSERT INTO outbox_events (id,topic,event_id,source_type,source_id,source_seq,owner_org_unit_id,policy_json,targets_json,payload_json,available_at) VALUES (?,'job.start',?,'job_execution',?,1,?,'{}','[]',?,UTC_TIMESTAMP(3))", [newId(), eventId, id, job.owner_org_unit_id, canonicalJobJson({ executionId: id, generation: 1 })]);
      if (!await execution(id, input.executionFilter, conn)) throw new ForgeError("JOB-7101");
      await remember(conn, scope, key, requestHash, id);
      await audit(conn, options, job, "job.execute", id);
      return { executionId: id, replayed: false };
    }, "READ COMMITTED");
  },
};
async function remember(conn: PoolConnection, scope: string, key: string, hash: string, executionId: string): Promise<void> {
  await conn.execute("DELETE FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND expires_at<=UTC_TIMESTAMP(3)", [scope, key]);
  await conn.execute("INSERT INTO idempotency_keys (id,scope,idempotency_key,request_hash,status_code,response_json,expires_at) VALUES (?,?,?,?,202,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 24 HOUR))", [newId(), scope, key, hash, canonicalJobJson({ executionId })]);
}
