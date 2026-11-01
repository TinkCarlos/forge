import { afterAll, describe, expect, it, vi } from "vitest";
import { newId, sha256, type QueryFilter } from "@forge/core";
import { JOB_CREATE_SCHEMA } from "@forge/contracts";
import { jobsRepo, query, execute, type JobWrite } from "@forge/store";
import { auditRepo } from "../packages/store/src/repositories/audit.js";
import { jobFilterSql } from "../packages/store/src/job-filter.js";
const all: QueryFilter = { allow: [{ type: "all" }], deny: [], ceiling: { type: "all" } };
const none: QueryFilter = { ...all, allow: [] };
const actor = { type: "user" as const, id: "01J00000000000000000000001" };
const options: JobWrite = { actor, authorize: async () => {} };
const ids: string[] = [];
const manifest = { schemaVersion: 1, target: { kind: "agent", key: "demo-agent", version: "1", checksum: "a".repeat(64) }, inputSchema: { type: "object" }, outputSchema: {}, nodes: [] };
async function create() {
  const row = await jobsRepo.createJob(JOB_CREATE_SCHEMA.parse({ key: `test-${newId().toLowerCase()}`, name: "事务协议测试", businessType: "technical", draft: manifest }), all, options);
  ids.push(row.id);
  return row;
}
async function active() {
  const row = await create();
  const version = await jobsRepo.publishJob(row.id, row.revision, all, options, async () => {});
  await jobsRepo.updateJob(row.id, { status: "active" }, version.revision, all, options);
  return row;
}
function admission(jobId: string, key = "request-one", business = "one") {
  return { jobId, invoke: { input: { value: 1 }, businessRef: { type: "technical", id: business } }, businessKeyHash: sha256(business), idempotencyKey: key,
    executionFilter: all, definitionFilter: all, runtimeEngine: "mysql-agent-bridge" as const, snapshot: { quality: "legacy" }, triggerType: "manual" as const,
    initialSteps: [{ key: "agent", itemKey: "", kind: "agent", input: {}, readOnly: true }], validate: async () => {},
  };
}
afterAll(async () => {
  for (const id of ids) {
    await execute("DELETE o FROM outbox_events o JOIN job_executions e ON e.id=o.source_id WHERE e.job_id=?", [id]);
    await execute("DELETE ev FROM job_events ev JOIN job_executions e ON e.id=ev.execution_id WHERE e.job_id=?", [id]);
    await execute("DELETE s FROM job_steps s JOIN job_executions e ON e.id=s.execution_id WHERE e.job_id=?", [id]);
    await execute("DELETE FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.executionId')) IN (SELECT id FROM job_executions WHERE job_id=?)", [id]);
    await execute("DELETE a FROM audit_logs a JOIN job_executions e ON e.id=a.resource_id WHERE e.job_id=?", [id]);
    await execute("DELETE FROM job_executions WHERE job_id=?", [id]);
    await execute("UPDATE job_definitions SET published_version_id=NULL WHERE id=?", [id]);
    await execute("DELETE FROM job_definition_versions WHERE job_id=?", [id]);
    await execute("DELETE FROM job_definitions WHERE id=?", [id]);
    await execute("DELETE FROM audit_logs WHERE resource_id=?", [id]);
  }
});
describe("Job admission, real MySQL technical protocol vectors", () => {
  it("creates disabled definitions, keeps omitted PATCH fields, publishes immutable versions and applies CAS", async () => {
    const row = await create();
    expect(row.status).toBe("disabled");
    const first = await jobsRepo.publishJob(row.id, 1, all, options, async () => {});
    const updated = await jobsRepo.updateJob(row.id, { name: "改名", description: "保留说明" }, first.revision, all, options);
    const renamed = await jobsRepo.updateJob(row.id, { name: "第二次改名" }, updated.revision, all, options);
    expect(renamed).toMatchObject({ description: "保留说明", status: "disabled" });
    await expect(jobsRepo.updateJob(row.id, { name: "旧页面" }, 1, all, options)).rejects.toMatchObject({ code: "JOB-7106" });
    const versions = await query<{ manifest_hash: string }>("SELECT manifest_hash FROM job_definition_versions WHERE job_id=?", [row.id]);
    expect(versions).toEqual([{ manifest_hash: first.manifestHash }]);
  });
  it("filters every detail/list in SQL with allow-minus-deny and an independent ceiling", async () => {
    const row = await create();
    expect(await jobsRepo.getJob(row.id, none)).toBeNull();
    expect((await jobsRepo.listJobs(none)).items).toEqual([]);
    const deny = { ...all, deny: [{ type: "resources" as const, ids: [row.id] }] };
    expect(await jobsRepo.getJob(row.id, deny)).toBeNull();
    expect(await jobsRepo.getJob(row.id, { ...all, ceiling: { type: "orgs", ids: [] } })).toBeNull();
    const malicious = "x') OR TRUE --";
    const compiled = jobFilterSql({ ...all, allow: [{ type: "orgs", ids: [malicious] }] }, "definition");
    expect(compiled.sql).not.toContain(malicious); expect(compiled.params).toContain(malicious);
  });
  it("binds signed pagination to the current filter and rejects edited cursors", async () => {
    await create(); await create();
    const page = await jobsRepo.listJobs(all, { limit: 1 }); expect(page.nextCursor).toBeTypeOf("string");
    const next = await jobsRepo.listJobs(all, { limit: 1, cursor: page.nextCursor! });
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    await expect(jobsRepo.listJobs(none, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: "CFG-8501" });
    await expect(jobsRepo.listJobs(all, { cursor: page.nextCursor!.slice(0, -1) + "x" })).rejects.toMatchObject({ code: "CFG-8501" });
  });
  it("serializes concurrent admission and preserves durable business deduplication after HTTP cache expiry", async () => {
    const row = await active(), input = admission(row.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => jobsRepo.admitJob(input, options)));
    expect(new Set(results.map(value => value.executionId)).size).toBe(1);
    expect(results.filter(value => !value.replayed)).toHaveLength(1);
    const id = results[0]!.executionId;
    for (const [table, column] of [["job_events", "execution_id"], ["job_steps", "execution_id"], ["outbox_events", "source_id"]]) expect(await query(`SELECT id FROM ${table === "job_events" ? "(SELECT event_id AS id,execution_id FROM job_events) events" : table} WHERE ${column}=?`, [id])).toHaveLength(1);
    expect(await query("SELECT id FROM audit_logs WHERE action='job.execute' AND resource_id=?", [id])).toHaveLength(1);
    await execute("DELETE FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.executionId'))=?", [id]);
    expect(await jobsRepo.admitJob(admission(row.id, "new-http-key"), options)).toEqual({ executionId: id, replayed: true });
    const changed = { ...admission(row.id, "another-key"), invoke: { input: { value: 2 }, businessRef: { type: "technical", id: "one" } } };
    await expect(jobsRepo.admitJob(changed, options)).rejects.toMatchObject({ code: "JOB-7103" });
  });
  it("authorizes before replay, conceals invisible prior executions and rolls back all rejected writes", async () => {
    const row = await active(), input = admission(row.id), accepted = await jobsRepo.admitJob(input, options);
    await expect(jobsRepo.admitJob(input, { ...options, authorize: async () => { throw new Error("revoked"); } })).rejects.toThrow("revoked");
    await expect(jobsRepo.admitJob({ ...input, executionFilter: none }, options)).rejects.toMatchObject({ code: "JOB-7101" });
    await expect(jobsRepo.admitJob({ ...admission(row.id, "other", "two"), executionFilter: none }, options)).rejects.toMatchObject({ code: "JOB-7101" });
    expect(await query("SELECT id FROM job_executions WHERE job_id=?", [row.id])).toEqual([{ id: accepted.executionId }]);
  });
  it("enforces the queued ceiling without creating a 51st execution or outbox record", async () => {
    const row = await active();
    for (let n = 0; n < 50; n++) await jobsRepo.admitJob(admission(row.id, `key-${n}`, `business-${n}`), options);
    await expect(jobsRepo.admitJob(admission(row.id, "overflow", "overflow"), options)).rejects.toMatchObject({ code: "JOB-7105" });
    expect(await query("SELECT id FROM job_executions WHERE job_id=?", [row.id])).toHaveLength(50);
  });
});

it("unrelated deny scopes do not hide NULL-owned rows or non-App executions", async () => {
  const row = await active();
  const denyOrg: QueryFilter = { ...all, deny: [{ type: "orgs", ids: [newId()] }] };
  expect((await jobsRepo.getJob(row.id, denyOrg))?.id).toBe(row.id);
  const accepted = await jobsRepo.admitJob(admission(row.id), options);
  const denyApp: QueryFilter = { ...all, deny: [{ type: "app", appId: newId() }] };
  expect((await jobsRepo.getJobExecution(accepted.executionId, denyApp))?.id).toBe(accepted.executionId);
});
it("durable same-business replay survives disablement and incompatible current versions", async () => {
  const row = await active(), input = admission(row.id);
  const accepted = await jobsRepo.admitJob(input, options);
  const current = (await jobsRepo.getJob(row.id, all))!;
  await jobsRepo.updateJob(row.id, { status: "disabled" }, current.revision, all, options);
  await execute("DELETE FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.executionId'))=?", [accepted.executionId]);
  expect(await jobsRepo.admitJob({ ...input, idempotencyKey: "fresh-key", validate: async () => { throw new Error("current version no longer accepts input"); } }, options)).toEqual({ executionId: accepted.executionId, replayed: true });
  await expect(jobsRepo.admitJob(admission(row.id, "different", "different"), options)).rejects.toMatchObject({ code: "JOB-7102" });
});

it("idempotency keys keep ASCII case distinct despite the legacy table collation", async () => {
  const row = await active();
  const upper = await jobsRepo.admitJob(admission(row.id, "Case-Key", "first"), options);
  const lower = await jobsRepo.admitJob(admission(row.id, "case-key", "second"), options);
  expect(upper.executionId).not.toBe(lower.executionId);
});
it("audit failure rolls execution, initial steps, event, outbox and HTTP response back together", async () => {
  const row = await active();
  const audit = vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("audit write failed"));
  try { await expect(jobsRepo.admitJob(admission(row.id), options)).rejects.toThrow("audit write failed"); }
  finally { audit.mockRestore(); }
  expect(await query("SELECT id FROM job_executions WHERE job_id=?", [row.id])).toEqual([]);
  expect(await query("SELECT id FROM outbox_events WHERE source_id NOT IN (SELECT id FROM job_executions) AND source_type='job_execution'")).toEqual([]);
  expect(await query("SELECT execution_id FROM job_events WHERE execution_id NOT IN (SELECT id FROM job_executions)")).toEqual([]);
});
it("deletion protects historical versions and retains the key of an unused draft", async () => {
  const used = await active();
  const current = (await jobsRepo.getJob(used.id, all))!;
  await expect(jobsRepo.deleteJob(used.id, current.revision, all, options)).rejects.toMatchObject({ code: "JOB-7102" });
  const unused = await create();
  await jobsRepo.deleteJob(unused.id, unused.revision, all, options);
  expect(await jobsRepo.getJob(unused.id, all)).toBeNull();
  expect(await query("SELECT `key`,status FROM job_definitions WHERE id=?", [unused.id])).toEqual([{ key: unused.key, status: "deleted" }]);
});
it("version and App-grant writes enforce parent CAS, scoped reads and application validation", async () => {
  const row = await active(), current = (await jobsRepo.getJob(row.id, all))!;
  expect(await jobsRepo.getJobVersion(row.id, current.published_version_id!, none)).toBeNull();
  expect((await jobsRepo.getJobVersion(row.id, current.published_version_id!, all))?.job_id).toBe(row.id);
  const appId = newId();
  await execute("INSERT INTO api_apps(id,`key`,name,scopes_json) VALUES (?,?,'technical','[]')", [appId, `app-${appId.toLowerCase()}`]);
  try {
    const request = { appId, actions: ["run"], status: "active" };
    await expect(jobsRepo.setJobAppGrant(row.id, appId, request, current.revision, all, options, async () => { throw new Error("app not allowed"); })).rejects.toThrow("app not allowed");
    expect(await query("SELECT id FROM job_app_grants WHERE job_id=?", [row.id])).toEqual([]);
    const revision = await jobsRepo.setJobAppGrant(row.id, appId, request, current.revision, all, options, async () => {});
    expect(revision).toBe(current.revision + 1);
    await expect(jobsRepo.setJobAppGrant(row.id, appId, request, current.revision, all, options, async () => {})).rejects.toMatchObject({ code: "JOB-7106" });
    expect(await query("SELECT actions_json,revision FROM job_app_grants WHERE job_id=?", [row.id])).toEqual([{ actions_json: ["run"], revision: 1 }]);
  } finally { await execute("DELETE FROM job_app_grants WHERE job_id=?", [row.id]); await execute("DELETE FROM api_apps WHERE id=?", [appId]); }
});

it("published identity fields allow unchanged form values while rejecting actual changes", async () => {
  const row = await active(), current = (await jobsRepo.getJob(row.id, all))!;
  const updated = await jobsRepo.updateJob(row.id, { businessType: current.business_type, orgUnitId: current.owner_org_unit_id, name: "保存完整表单" }, current.revision, all, options);
  expect(updated.name).toBe("保存完整表单");
  await expect(jobsRepo.updateJob(row.id, { businessType: "changed" }, updated.revision, all, options)).rejects.toMatchObject({ code: "CFG-8501" });
});
