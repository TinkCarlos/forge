import { type FastifyInstance, type FastifyRequest } from "fastify";
import { errors, ForgeError, type Principal } from "@forge/core";
import { assertScope } from "@forge/governance";
import { authenticateApiKey } from "@forge/identity";
import {
  cancelRun,
  clampWaitSeconds,
  createQueuedRun,
  idempotencyRequestHash,
  invokeStatusCode,
  resolveIdempotentCreate,
  waitForRun,
} from "@forge/runtime";
import { repos, type AgentRow, type RunRow } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  presentRun,
  streamRun,
} from "../plugins/http-helpers.js";

interface AppContext {
  principal: Principal;
  app: Record<string, unknown>;
}

const rateBuckets = new Map<string, { minute: number; count: number }>();

async function openApp(request: FastifyRequest, scope: string): Promise<AppContext> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw errors.unauthorized("缺少 API Key");
  const principal = await authenticateApiKey(header.slice(7));
  assertScope(principal, scope);
  const app = principal.appId ? await repos.getApiApp(principal.appId) : null;
  if (!app || app.status !== "active") throw errors.unauthorized("应用已停用");
  const minute = Math.floor(Date.now() / 60000);
  const bucket = rateBuckets.get(principal.id);
  if (!bucket || bucket.minute !== minute) {
    rateBuckets.set(principal.id, { minute, count: 1 });
  } else {
    bucket.count += 1;
    const limit = Number(app.rate_limit_per_minute ?? 60);
    if (bucket.count > limit) throw new ForgeError("OPN-4502", "请求频率超限", 429, { limit, window: "minute" }, true);
  }
  return { principal, app };
}

function openPresentRun(run: RunRow) {
  return presentRun(run);
}

async function appCanAccessAgent(app: Record<string, unknown>, agent: AgentRow): Promise<boolean> {
  if (!agent.owner_org_unit_id) return true;
  const ownerOrg = app.owner_org_unit_id ? String(app.owner_org_unit_id) : null;
  if (!ownerOrg) return false;
  const orgIds = await repos.orgSubtreeIds(ownerOrg);
  return orgIds.includes(agent.owner_org_unit_id);
}

export default async function openRoutes(app: FastifyInstance): Promise<void> {
  app.get("/open/v1/agents", async (request) => {
    const context = await openApp(request, "agents:read");
    const agents = await repos.listAgents(null);
    const items = [];
    for (const agent of agents) {
      if (!agent.api_enabled || !agent.published_version_id) continue;
      if (!(await appCanAccessAgent(context.app, agent))) continue;
      const version = await repos.getAgentVersion(agent.published_version_id);
      items.push({ key: agent.key, name: agent.name, description: agent.description, version: version?.version ?? null });
    }
    return { items };
  });

  app.get("/open/v1/agents/:key", async (request) => {
    const context = await openApp(request, "agents:read");
    const agent = await repos.getAgentByKey(param(request, "key"));
    if (!agent || !agent.api_enabled || !agent.published_version_id || !(await appCanAccessAgent(context.app, agent))) throw errors.notFound("Agent 不存在");
    const version = await repos.getAgentVersion(agent.published_version_id);
    return { key: agent.key, name: agent.name, description: agent.description, version: version?.version ?? null };
  });

  app.post("/open/v1/agents/:key/runs", async (request, reply) => {
    const context = await openApp(request, "runs:create");
    const agent = await repos.getAgentByKey(param(request, "key"));
    if (!agent || !agent.api_enabled || !agent.published_version_id || !(await appCanAccessAgent(context.app, agent))) throw errors.notFound("Agent 不存在");
    const appOrg = context.app.owner_org_unit_id ? String(context.app.owner_org_unit_id) : null;
    const runCount = await repos.countAppRunsToday(String(context.app.id));
    if (runCount >= Number(context.app.daily_quota ?? 1000)) throw new ForgeError("OPN-4501", "应用今日配额已用完", 429);
    const body = bodyOf(request);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const versionId = agent.published_version_id;
    if (!versionId) throw errors.notFound("Agent 不存在");
    const principal: Principal = { ...context.principal, orgUnitId: appOrg };
    const input = jsonBody(body, "input", { text: stringBody(body, "text", "") });
    const result = await resolveIdempotentCreate({
      scope: String(context.app.id),
      key: idempotencyKey,
      requestHash: idempotencyRequestHash({ agentKey: agent.key, body }),
      create: async () => {
        const runId = await createQueuedRun({
          agentId: agent.id,
          versionId,
          principal,
          input,
          appId: String(context.app.id),
          threadId: stringBody(body, "threadId") || null,
        });
        await repos.audit({ actorType: "app", actorId: String(context.app.id), action: "open.run.create", resourceType: "run", resourceId: runId, details: { agentKey: agent.key } });
        const created = await repos.getRun(runId);
        return { statusCode: 202, runId, body: { runId, threadId: created?.thread_id ?? null, status: "queued", agentKey: agent.key } };
      },
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    reply.status(result.statusCode);
    return result.body;
  });

  app.post("/open/v1/agents/:key/invoke", async (request, reply) => {
    const context = await openApp(request, "runs:create");
    const agent = await repos.getAgentByKey(param(request, "key"));
    if (!agent || !agent.api_enabled || !agent.published_version_id || !(await appCanAccessAgent(context.app, agent))) throw errors.notFound("Agent 不存在");
    const versionId = agent.published_version_id;
    const appOrg = context.app.owner_org_unit_id ? String(context.app.owner_org_unit_id) : null;
    const runCount = await repos.countAppRunsToday(String(context.app.id));
    if (runCount >= Number(context.app.daily_quota ?? 1000)) throw new ForgeError("OPN-4501", "应用今日配额已用完", 429);
    const body = bodyOf(request);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const wait = clampWaitSeconds((request.query as Record<string, unknown>).wait, 30);
    const principal: Principal = { ...context.principal, orgUnitId: appOrg };
    const input = jsonBody(body, "input", { text: stringBody(body, "text", "") });
    const result = await resolveIdempotentCreate({
      scope: String(context.app.id),
      key: idempotencyKey,
      requestHash: idempotencyRequestHash({ agentKey: agent.key, mode: "invoke", wait, body }),
      create: async () => {
        const runId = await createQueuedRun({
          agentId: agent.id,
          versionId,
          principal,
          input,
          appId: String(context.app.id),
          threadId: stringBody(body, "threadId") || null,
        });
        await repos.audit({ actorType: "app", actorId: String(context.app.id), action: "open.run.create", resourceType: "run", resourceId: runId, details: { agentKey: agent.key, wait } });
        const waited = await waitForRun(runId, wait);
        const run = waited.run ?? (await repos.getRun(runId));
        if (!run || invokeStatusCode(run.status) === 202) {
          return { statusCode: 202, runId, body: { runId, threadId: run?.thread_id ?? null, status: run?.status ?? "queued", agentKey: agent.key } };
        }
        return {
          statusCode: 200,
          runId,
          body: {
            runId: run.id,
            threadId: run.thread_id,
            status: run.status,
            output: run.output_json,
            usage: run.usage_json,
            error: run.error_code ? { code: run.error_code, message: run.error_message } : null,
            completedAt: run.completed_at,
          },
        };
      },
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    reply.status(result.statusCode);
    return result.body;
  });

  app.get("/open/v1/runs/:id", async (request) => {
    const context = await openApp(request, "runs:read");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    return openPresentRun(run);
  });

  app.get("/open/v1/runs/:id/result", async (request) => {
    const context = await openApp(request, "runs:read");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    if (!["succeeded", "failed", "cancelled", "budget_exhausted"].includes(run.status)) throw new ForgeError("RUN-7002", "Run 尚未结束", 409, { status: run.status });
    return { runId: run.id, status: run.status, output: run.output_json, error: run.error_code ? { code: run.error_code, message: run.error_message } : null, usage: run.usage_json, completedAt: run.completed_at };
  });

  app.get("/open/v1/runs/:id/events", async (request, reply) => {
    const context = await openApp(request, "runs:read");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    await streamRun(request, reply, run.id);
  });

  app.post("/open/v1/runs/:id/cancel", async (request) => {
    const context = await openApp(request, "runs:cancel");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    await cancelRun(run.id);
    return { ok: true, status: "cancelling" };
  });

  app.get("/open/v1/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Forge Open API", version: "1.0.0" },
    servers: [{ url: "/open/v1" }],
    paths: {
      "/agents": { get: { summary: "List exposed agents", security: [{ apiKey: [] }] } },
      "/agents/{key}/runs": { post: { summary: "Create a run", security: [{ apiKey: [] }] } },
      "/agents/{key}/invoke": { post: { summary: "Create a run and wait", security: [{ apiKey: [] }] } },
      "/runs/{id}": { get: { summary: "Get run", security: [{ apiKey: [] }] } },
      "/runs/{id}/events": { get: { summary: "SSE events", security: [{ apiKey: [] }] } },
      "/runs/{id}/result": { get: { summary: "Get result", security: [{ apiKey: [] }] } },
      "/runs/{id}/cancel": { post: { summary: "Cancel run", security: [{ apiKey: [] }] } },
    },
    components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer" } } },
  }));
}
