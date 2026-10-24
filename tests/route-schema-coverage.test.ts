import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, RouteOptions } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// attachValidation backstop (needs a *_test DB). Routes declare { schema, attachValidation: true } and must call
// assertValidInput themselves; a route that forgets would silently accept anything. This test collects EVERY route
// the real app registers (onRoute hook on the root instance, inherited by all plugins), keeps the ones with a body or
// querystring schema, and sends each an invalid request as a platform_admin on an existing resource: each must
// answer 400 CFG-8501. A new schema route without an entry in FIXTURES fails the test until it gets one.
const seen = vi.hoisted(() => [] as RouteOptions[]);
vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const factory = ((...args: Parameters<typeof mod.default>) => {
    const instance = mod.default(...args);
    instance.addHook("onRoute", (route) => {
      seen.push(route as RouteOptions);
    });
    return instance;
  }) as typeof mod.default;
  return { ...mod, default: factory, fastify: factory };
});
const { buildApp } = await import("../apps/api/src/app.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
const ids: Record<string, string> = {};

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; maxLength?: number; maxItems?: number; items?: JsonSchema };

/**
 * Per schema route: path params and body fields that reference existing rows (real ids, so the 404 lookups that run
 * before validation pass, e.g. POST /admin/api/schedules resolves agentId / serviceAccountId first). Every other
 * declared field gets an invalid value.
 */
const FIXTURES: Record<string, () => { params?: Record<string, string>; keep?: Record<string, string> }> = {
  "/admin/api/agents": () => ({}),
  "/admin/api/agents/:id": () => ({ params: { id: ids.agent! } }),
  "/admin/api/users": () => ({}),
  "/admin/api/audit": () => ({}),
  "/admin/api/runs": () => ({}),
  "/admin/api/approvals/:id/decide": () => ({ params: { id: ids.approval! } }),
  "/admin/api/schedules": () => ({ keep: { agentId: ids.agent!, serviceAccountId: ids.account! } }),
  "/admin/api/schedules/:id": () => ({ params: { id: ids.schedule! } }),
};

/** A value every schema rejects for this property: over maxLength / maxItems, else the wrong JSON type. */
function invalidValue(schema: JsonSchema): unknown {
  if (schema.maxLength !== undefined) return "9".repeat(schema.maxLength + 1);
  if (schema.maxItems !== undefined) return Array.from({ length: schema.maxItems + 1 }, () => invalidValue(schema.items ?? { type: "string" }));
  return schema.type === "string" ? 12345 : "not-the-right-type";
}

function invalidObject(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, prop]) => [key, invalidValue(prop)]));
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT schema coverage", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  ids.agent = await repos.createAgent({ key: `it-rsc-${suffix}`, name: "IT rsc", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  ids.version = await repos.createAgentVersion({ agentId: ids.agent, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(ids.agent, ids.version);
  const threadId = await repos.createThread({ agentId: ids.agent, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  ids.run = await repos.createRun({ threadId, agentId: ids.agent, agentVersionId: ids.version, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "waiting_approval" });
  const toolCallId = await repos.addToolCall({ runId: ids.run, toolKey: "mail.send", args: { to: "a@example.com" }, risk: "high", status: "pending" });
  ids.approval = await repos.addApproval({ runId: ids.run, toolCallId, risk: "high", timeoutSeconds: 3600 });
  ids.account = await repos.createServiceAccount({ key: `it-rsc-svc-${suffix}`, name: "IT rsc svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  ids.schedule = await repos.createSchedule({
    key: `it-rsc-${suffix}`, name: "IT rsc", agentId: ids.agent, orgUnitId: ROOT, subjectType: "service", subjectId: ids.account, serviceAccountId: ids.account,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", nextRunAt: null, createdBy: ADMIN_ID,
  });
});

afterAll(async () => {
  if (ids.agent) {
    await execute("DELETE FROM schedules WHERE agent_id = ?", [ids.agent]);
    await execute("DELETE p FROM approvals p JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [ids.agent]);
    await execute("DELETE t FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.agent_id = ?", [ids.agent]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [ids.agent]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [ids.agent]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [ids.agent]);
    await execute("DELETE FROM agents WHERE `key` LIKE ?", [`it-rsc-%${suffix}`]);
  }
  if (ids.account) await execute("DELETE FROM service_accounts WHERE id = ?", [ids.account]);
  await execute("DELETE FROM users WHERE email LIKE ?", [`%${suffix}%`]);
  await cleanupRealSessions();
  await app?.close();
});

function schemaRoutes(): Array<{ method: string; url: string; part: "body" | "querystring"; schema: JsonSchema }> {
  const out: Array<{ method: string; url: string; part: "body" | "querystring"; schema: JsonSchema }> = [];
  for (const route of seen) {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== "HEAD");
    for (const part of ["body", "querystring"] as const) {
      const schema = route.schema?.[part] as JsonSchema | undefined;
      if (schema) for (const method of methods) out.push({ method, url: route.url, part, schema });
    }
  }
  return out;
}

describe("every route with a body / querystring schema rejects invalid input with 400 (attachValidation backstop)", () => {
  it("the collector sees the schema routes (guards the hook itself)", () => {
    const keys = schemaRoutes().map((r) => `${r.method} ${r.url} ${r.part}`);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys).toContain("POST /admin/api/agents body");
    expect(keys).toContain("GET /admin/api/runs querystring");
  });

  it("each one answers 400 CFG-8501 to an invalid request from an authorised caller", async () => {
    const results: Array<{ route: string; status: number; code?: string }> = [];
    for (const route of schemaRoutes()) {
      const fixture = FIXTURES[route.url];
      expect(fixture, `no FIXTURES entry for ${route.method} ${route.url}`).toBeDefined();
      const { params = {}, keep = {} } = fixture!();
      const url = route.url.replace(/:(\w+)/g, (_, name: string) => params[name] ?? `missing-${name}`);
      const invalid = { ...invalidObject(route.schema), ...keep };
      const res = route.part === "body"
        ? await app.inject({ method: route.method as "POST", url, headers, payload: invalid })
        : await app.inject({ method: route.method as "GET", url: `${url}?${new URLSearchParams(Object.entries(invalid).map(([k, v]) => [k, String(v)])).toString()}`, headers });
      const body = res.json() as { error?: { code?: string } };
      results.push({ route: `${route.method} ${route.url} ${route.part}`, status: res.statusCode, code: body.error?.code });
    }
    expect(results.filter((r) => r.status !== 400 || r.code !== "CFG-8501")).toEqual([]);
  });
});
