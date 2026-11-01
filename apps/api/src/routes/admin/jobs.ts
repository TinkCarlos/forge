import Ajv2020 from "ajv/dist/2020.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { ForgeError, hasPermission, requireRevision, revisionTag, sha256, type Principal } from "@forge/core";
import { JOB_CREATE_SCHEMA, JOB_PATCH_SCHEMA, JOB_LIST_QUERY_SCHEMA, JOB_JSON_VALUE_SCHEMA, canonicalJobJson, type JobDetail, type JobManifest, type JobTarget } from "@forge/contracts";
import { agentJobTargets, jobsRepo, repos, type JobDefinitionRow, type JobWrite } from "@forge/store";
import { assertConfigCreate, assertPermission, canSeeUser, currentResourcePrincipal, resourceFilterFor } from "@forge/governance";
import { admin, param } from "../../plugins/http-helpers.js";
import { assertValidInput, ROUTE_SCHEMAS } from "../../plugins/input-schema.js";
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ForgeError("CFG-8501", { details: { fields: result.error.issues.map(issue => ({ path: issue.path.map(String).join("."), issue: issue.message })) } });
  return result.data;
}
function detail(row: JobDefinitionRow, editable: boolean, publishable = false): JobDetail {
  return { id: row.id, key: row.key, name: row.name, description: row.description, businessType: row.business_type,
    orgUnitId: row.owner_org_unit_id, responsibleUserId: row.responsible_user_id, status: row.status, revision: row.revision,
    publishedVersionId: row.published_version_id, allowedActions: [...(editable ? ["manage" as const] : []), ...(publishable ? ["publish" as const] : [])], ...(editable ? { draft: row.draft_json } : {}), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
async function present(rows: JobDefinitionRow[], principal: Principal): Promise<JobDetail[]> {
  const allowed=hasPermission(principal,"job.manage") ? await jobsRepo.manageableJobIds(rows.map(row=>row.id),await resourceFilterFor(principal,"job_definition","manage")) : [];
  const publish=hasPermission(principal,"job.publish") ? await jobsRepo.manageableJobIds(rows.map(row=>row.id),await resourceFilterFor(principal,"job_definition","publish")) : [];
  const ids=new Set(allowed),published=new Set(publish);return rows.map(row=>detail(row,ids.has(row.id),published.has(row.id)));
}
async function targets(principal: Principal, connection?: PoolConnection): Promise<JobTarget[]> {
  const { principal: live } = await currentResourcePrincipal(principal, connection); assertPermission(live, "agent.run");
  const rows = await agentJobTargets(await resourceFilterFor(principal, "agent", "run", connection), connection);
  return rows.map(row => ({ kind: "agent", key: row.key, name: row.name, version: row.version_id,
    checksum: sha256(canonicalJobJson({ id: row.version_id, instructions: row.instructions, spec: parse(JOB_JSON_VALUE_SCHEMA, row.spec_json) })),
    inputSchema: { type: "object" }, outputSchema: {}, runtimeEngine: "mysql-agent-bridge", snapshotQuality: "legacy" }));
}
function write(principal: Principal, permission: string, desiredOrg?: string | null, responsibleId?: string | null): JobWrite {
  return { actor: { type: principal.type, id: principal.id }, authorize: async (conn, row) => {
    const { principal: live } = await currentResourcePrincipal(principal, conn); assertPermission(live, permission);
    if (row) {
      const filter = await resourceFilterFor(principal, "job_definition", permission.split(".")[1]!, conn);
      if (!await jobsRepo.getJob(row.id, filter, conn)) throw new ForgeError("JOB-7101");
    }
    if (responsibleId) {
      const responsible=await repos.getActiveUserById(responsibleId,conn);
      if(!responsible || !await canSeeUser(live,responsible,conn))throw new ForgeError("JOB-7101",{message:"负责人不存在或不可分配"});
    }
    if (!row || desiredOrg !== undefined) await assertConfigCreate(principal, permission, "job_definition", desiredOrg === undefined ? live.orgUnitId : desiredOrg, conn);
  } };
}
async function load(id: string, principal: Principal, action = "view") {
  const row = await jobsRepo.getJob(id, await resourceFilterFor(principal, "job_definition", action));
  if (!row) throw new ForgeError("JOB-7101");
  return row;
}
function tag(reply: FastifyReply, revision: number): void { reply.header("ETag", revisionTag(revision)).header("Cache-Control", "no-store"); }
export default async function adminJobRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/job-targets", async request => { const { principal } = await admin(request, "job.manage"); return { items: await targets(principal), nextCursor: null }; });
  app.get("/admin/api/jobs", { schema: ROUTE_SCHEMAS.jobList, attachValidation: true }, async request => {
    const { principal } = await admin(request, "job.view"); assertValidInput(request, "querystring"); const input = parse(JOB_LIST_QUERY_SCHEMA, request.query);
    const page = await jobsRepo.listJobs(await resourceFilterFor(principal, "job_definition", "view"), { ...input, limit: input.limit ? Number(input.limit) : 50 });
    return { ...page, items: await present(page.items, principal) };
  });
  app.get("/admin/api/jobs/:id", async (request, reply) => { const { principal } = await admin(request, "job.view"); const row = await load(param(request, "id"), principal); tag(reply, row.revision); return (await present([row],principal))[0]; });
  app.post("/admin/api/jobs", { schema: ROUTE_SCHEMAS.jobCreate, attachValidation: true }, async (request, reply) => {
    const { principal } = await admin(request, "job.manage"); assertValidInput(request); const input = parse(JOB_CREATE_SCHEMA, request.body);
    input.orgUnitId = input.orgUnitId === undefined ? principal.orgUnitId : input.orgUnitId;
    const row = await jobsRepo.createJob(input, await resourceFilterFor(principal, "job_definition", "manage"), write(principal, "job.manage", input.orgUnitId, input.responsibleUserId));
    tag(reply, row.revision); return reply.code(201).send(detail(row, true));
  });
  app.patch("/admin/api/jobs/:id", { schema: ROUTE_SCHEMAS.jobPatch, attachValidation: true }, async (request, reply) => {
    const { principal } = await admin(request, "job.manage"), id = param(request, "id"); await load(id, principal, "manage"); assertValidInput(request);
    const input = parse(JOB_PATCH_SCHEMA, request.body);
    const row = await jobsRepo.updateJob(id, input, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "job_definition", "manage"), write(principal, "job.manage", input.orgUnitId, input.responsibleUserId));
    tag(reply, row.revision); return (await present([row],principal))[0];
  });
  app.delete("/admin/api/jobs/:id",{schema: ROUTE_SCHEMAS.noBody,attachValidation:true}, async (request, reply) => {
    const { principal } = await admin(request, "job.manage"), id = param(request, "id"); await load(id, principal, "manage");
    assertValidInput(request);
    await jobsRepo.deleteJob(id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "job_definition", "manage"), write(principal, "job.manage")); return reply.code(204).send();
  });
  app.get("/admin/api/jobs/:id/versions", { schema: ROUTE_SCHEMAS.jobList, attachValidation: true }, async request => {
    const { principal } = await admin(request, "job.view"), id = param(request, "id"); await load(id, principal); assertValidInput(request, "querystring"); const input = parse(JOB_LIST_QUERY_SCHEMA, request.query);
    const page = await jobsRepo.listJobVersions(id, await resourceFilterFor(principal, "job_definition", "view"), { limit: input.limit ? Number(input.limit) : 50, cursor: input.cursor });
    return { ...page, items: page.items.map(row => ({ id: row.id, jobId: row.job_id, version: row.version, manifestHash: row.manifest_hash, createdAt: row.created_at.toISOString() })) };
  });
  app.post("/admin/api/jobs/:id/publish", { schema: ROUTE_SCHEMAS.jobEmpty, attachValidation: true }, async (request, reply) => {
    const { principal } = await admin(request, "job.publish"), id = param(request, "id"); await load(id, principal, "publish"); assertValidInput(request);
    const published = await jobsRepo.publishJob(id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "job_definition", "publish"), write(principal, "job.publish"), async (manifest: JobManifest, conn) => {
      try { for (const schema of [manifest.inputSchema,manifest.outputSchema]) new Ajv2020({strict:false,validateFormats:false,ownProperties:true}).compile(schema); }
      catch { throw new ForgeError("QAL-7301",{message:"任务输入或输出 Schema 无效"}); }
      const candidates = await targets(principal, conn);
      if (!candidates.some(target => target.kind === manifest.target.kind && target.key === manifest.target.key && target.version === manifest.target.version && target.checksum === manifest.target.checksum)) throw new ForgeError("JOB-7108");
      // Native targets must wait for their frozen-snapshot/Temporal capability registration.
      if (manifest.target.kind !== "agent" || manifest.nodes.length || manifest.resourcePolicy || manifest.eligibilityAdapter) throw new ForgeError("JOB-7108");
    });
    tag(reply, published.revision); return reply.code(201).send(published);
  });
}
