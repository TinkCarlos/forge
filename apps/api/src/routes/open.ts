import { type FastifyInstance, type FastifyRequest } from "fastify";
import { errors, ForgeError, type Principal } from "@forge/core";
import { assertScope, effectiveKeyScopes } from "@forge/governance";
import { authenticateApiKey } from "@forge/identity";
import {
  assertAgentRunnable,
  cancelRun,
  clampWaitSeconds,
  createQueuedRun,
  idempotencyRequestHash,
  invokeStatusCode,
  resolveIdempotentCreate,
  waitForRun,
} from "@forge/runtime";
import { parseJsonValue, repos, type AgentRow, type RunRow } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  externalRunInputBody,
  presentRun,
  presentRunOutput,
  streamRun,
} from "../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../plugins/input-schema.js";

interface AppContext {
  principal: Principal;
  app: Record<string, unknown>;
}

/** Retry-After (seconds) for the daily quota when the DB cannot report the time to its next midnight. */
const DAILY_RETRY_AFTER_FALLBACK = 3600;
const rateBuckets = new Map<string, { minute: number; count: number }>();

/** The app's current scopes (api_apps.scopes_json); anything but an array of strings counts as none. */
function appScopesOf(app: Record<string, unknown>): string[] {
  const scopes = parseJsonValue<unknown>(app.scopes_json, []);
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
}

async function openApp(request: FastifyRequest, scope: string, countRequest = true): Promise<AppContext> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw errors.unauthorized("缺少 API Key");
  const keyPrincipal = await authenticateApiKey(header.slice(7));
  const app = keyPrincipal.appId ? await repos.getApiApp(keyPrincipal.appId) : null;
  // P2: effective scopes = Key scopes ∩ the app's current scopes, read on every request (no cache). The Key row is
  // never rewritten. A missing app keeps the Key's own scopes here and is rejected as 401 below (same order as before).
  const principal: Principal = app
    ? { ...keyPrincipal, scopes: effectiveKeyScopes(keyPrincipal.scopes ?? [], appScopesOf(app)) }
    : keyPrincipal;
  assertScope(principal, scope);
  if (!app || app.status !== "active") throw errors.unauthorized("应用已停用");
  if (!countRequest) return { principal, app };
  const minute = Math.floor(Date.now() / 60000);
  const bucket = rateBuckets.get(principal.id);
  if (!bucket || bucket.minute !== minute) {
    rateBuckets.set(principal.id, { minute, count: 1 });
  } else {
    bucket.count += 1;
    const limit = Number(app.rate_limit_per_minute ?? 60);
    if (bucket.count > limit) {
      // P3: Retry-After = whole seconds left in the current fixed one-minute window (at least 1).
      const retryAfter = Math.max(1, Math.ceil(((minute + 1) * 60000 - Date.now()) / 1000));
      throw new ForgeError("OPN-4502", { message: "请求频率超限", httpStatus: 429, details: { limit, window: "minute" }, retryable: true, headers: { "Retry-After": String(retryAfter) } });
    }
  }
  return { principal, app };
}

/**
 * Daily Run quota (OPN-4501). P2 (architect on d26f2f4): called inside resolveIdempotentCreate's `create`, i.e. after
 * the Idempotency-Key is resolved, so replaying a stored response never hits the quota; a new key (or no key) on a
 * used-up quota is still 429 and its reservation is removed by resolveIdempotentCreate.
 */
async function assertDailyQuota(app: Record<string, unknown>): Promise<void> {
  const runCount = await repos.countAppRunsToday(String(app.id));
  if (runCount < Number(app.daily_quota ?? 1000)) return;
  // P3: Retry-After = seconds to the next 00:00 in the DB session time zone (the window countAppRunsToday uses),
  // clamped to 1..86400. If MySQL cannot tell (null or query error) the documented fallback is 3600.
  const seconds = await repos.secondsUntilNextDbDay().catch(() => null);
  const retryAfter = seconds === null ? DAILY_RETRY_AFTER_FALLBACK : Math.min(86_400, Math.max(1, Math.ceil(seconds)));
  throw new ForgeError("OPN-4501", { message: "应用今日配额已用完", httpStatus: 429, retryable: false, headers: { "Retry-After": String(retryAfter) } });
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

  app.post("/open/v1/agents/:key/runs", { schema: ROUTE_SCHEMAS.openRun, attachValidation: true }, async (request, reply) => {
    const context = await openApp(request, "runs:create");
    const agent = await repos.getAgentByKey(param(request, "key"));
    if (!agent || !agent.api_enabled || !agent.published_version_id || !(await appCanAccessAgent(context.app, agent))) throw errors.notFound("Agent 不存在");
    assertAgentRunnable(agent);
    assertValidInput(request);
    const appOrg = context.app.owner_org_unit_id ? String(context.app.owner_org_unit_id) : null;
    const body = bodyOf(request);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const versionId = agent.published_version_id;
    if (!versionId) throw errors.notFound("Agent 不存在");
    const principal: Principal = { ...context.principal, orgUnitId: appOrg };
    const input = externalRunInputBody(body);
    const result = await resolveIdempotentCreate({
      scope: String(context.app.id),
      key: idempotencyKey,
      requestHash: idempotencyRequestHash({ agentKey: agent.key, body }),
      create: async () => {
        await assertDailyQuota(context.app);
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

  app.post("/open/v1/agents/:key/invoke", { schema: ROUTE_SCHEMAS.openRun, attachValidation: true }, async (request, reply) => {
    const context = await openApp(request, "runs:create");
    const agent = await repos.getAgentByKey(param(request, "key"));
    if (!agent || !agent.api_enabled || !agent.published_version_id || !(await appCanAccessAgent(context.app, agent))) throw errors.notFound("Agent 不存在");
    assertAgentRunnable(agent);
    assertValidInput(request);
    const versionId = agent.published_version_id;
    const appOrg = context.app.owner_org_unit_id ? String(context.app.owner_org_unit_id) : null;
    const body = bodyOf(request);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const wait = clampWaitSeconds((request.query as Record<string, unknown>).wait, 30);
    const principal: Principal = { ...context.principal, orgUnitId: appOrg };
    const input = externalRunInputBody(body);
    const result = await resolveIdempotentCreate({
      scope: String(context.app.id),
      key: idempotencyKey,
      requestHash: idempotencyRequestHash({ agentKey: agent.key, mode: "invoke", wait, body }),
      create: async () => {
        await assertDailyQuota(context.app);
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
            output: presentRunOutput(run.output_json),
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
    if (!["succeeded", "failed", "cancelled", "budget_exhausted"].includes(run.status)) throw new ForgeError("RUN-7002", { message: "Run 尚未结束", httpStatus: 409, details: { status: run.status }, retryable: false });
    return { runId: run.id, status: run.status, output: presentRunOutput(run.output_json), error: run.error_code ? { code: run.error_code, message: run.error_message } : null, usage: run.usage_json, completedAt: run.completed_at };
  });

  app.get("/open/v1/runs/:id/events", { config: { sse: true } }, async (request, reply) => {
    const context = await openApp(request, "runs:read");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    await streamRun(request, reply, run.id, async () => {
      const live = await openApp(request, "runs:read", false);
      const current = await repos.getRun(run.id);
      if (!current || current.app_id !== String(live.app.id)) throw errors.notFound("Run 不存在");
    });
  });

  app.post("/open/v1/runs/:id/cancel", { schema: ROUTE_SCHEMAS.externalNoBody, attachValidation: true }, async (request) => {
    const context = await openApp(request, "runs:cancel");
    const run = await repos.getRun(param(request, "id"));
    if (!run || run.app_id !== String(context.app.id)) throw errors.notFound("Run 不存在");
    assertValidInput(request);
    await cancelRun(run.id);
    await repos.audit({ actorType: "app", actorId: String(context.app.id), action: "open.run.cancel", resourceType: "run", resourceId: run.id });
    // Report the real status (queued/waiting_approval -> cancelled; running stays running until the worker stops).
    const fresh = await repos.getRun(run.id);
    return { ok: true, status: fresh?.status ?? run.status };
  });

  app.get("/open/v1/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Forge Open API", version: "1.0.0" },
    servers: [{ url: "/open/v1" }],
    paths: {
      "/agents": { get: { summary: "List exposed agents", security: [{ apiKey: [] }] } },
      "/agents/{key}": { get: { summary: "Get exposed agent", security: [{ apiKey: [] }] } },
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
