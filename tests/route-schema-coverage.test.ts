import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, RouteOptions } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// attachValidation backstop (needs a *_test DB). Routes declare { schema, attachValidation: true } and must call
// assertValidInput themselves; a route that forgets would silently accept anything. This test collects EVERY route
// the real app registers (onRoute hook on the root instance, inherited by all plugins), keeps the ones with a body or
// querystring schema, and sends each an invalid request as a platform_admin on an existing resource: each must
// answer 400 CFG-8501. A new schema route without an entry in FIXTURES fails the test until it gets one.
// F1 (P1): also 403 before 400 (a caller without the permission gets 403 for the same invalid body) and an over-long
// path id stays 404 (ids are not in the schema; the lookup runs before validation). The static side (every
// body-accepting write route has a schema and calls the validator) is tests/route-body-schema-guard.test.ts.
const seen = vi.hoisted(() => [] as RouteOptions[]);
vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const create = mod.default as unknown as (...args: unknown[]) => FastifyInstance;
  const factory = ((...args: unknown[]) => {
    const instance = create(...args);
    instance.addHook("onRoute", (route) => {
      seen.push(route as RouteOptions);
    });
    return instance;
  }) as unknown as typeof mod.default;
  return { ...mod, default: factory, fastify: factory };
});
const { buildApp } = await import("../apps/api/src/app.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-rsc";
const audience = "forge-rsc";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let headers: Record<string, string> = {};
let userHeaders: Record<string, string> = {};
let openKey = "";
const ids: Record<string, string> = {};
const connectorToken = () =>
  new SignJWT({ principalType: "user", application: "rsc", environment: "test", roles: [], subject: `it-rsc-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; maxLength?: number; maxItems?: number; items?: JsonSchema; additionalProperties?: unknown };

/**
 * Per schema route: path params and body fields that reference existing rows (real ids, so the 404 lookups that run
 * before validation pass, e.g. POST /admin/api/schedules resolves agentId / serviceAccountId first). Every other
 * declared field gets an invalid value.
 */
type Fixture = { params?: Record<string, string>; keep?: Record<string, string>; auth?: "session" | "open" | "connector" | "none" };
const FIXTURES: Record<string, () => Fixture> = {
  "/admin/api/agents": () => ({}),
  "/admin/api/agents/:id": () => ({ params: { id: ids.agent! } }),
  "/admin/api/agents/:id/versions": () => ({ params: { id: ids.agent! } }),
  "/admin/api/agents/:id/publish": () => ({ params: { id: ids.agent! } }),
  "/admin/api/agents/:id/run": () => ({ params: { id: ids.agent! } }),
  "/admin/api/users": () => ({}),
  "/admin/api/users/:id": () => ({ params: { id: ids.user! } }),
  "/admin/api/role-mappings": () => ({}),
  "/admin/api/audit": () => ({}),
  "/admin/api/runs": () => ({}),
  "/admin/api/approvals/:id/decide": () => ({ params: { id: ids.approval! } }),
  "/admin/api/schedules": () => ({ keep: { agentId: ids.agent!, serviceAccountId: ids.account! } }),
  "/admin/api/schedules/:id": () => ({ params: { id: ids.schedule! } }),
  "/admin/api/apps": () => ({}),
  "/admin/api/apps/:id": () => ({ params: { id: ids.app! } }),
  "/admin/api/apps/:id/keys": () => ({ params: { id: ids.app! } }),
  "/admin/api/service-accounts": () => ({}),
  "/admin/api/service-accounts/:id": () => ({ params: { id: ids.account! } }),
  "/admin/api/mcp": () => ({}),
  "/admin/api/mcp/:id": () => ({ params: { id: ids.mcp! } }),
  "/admin/api/skills": () => ({}),
  "/admin/api/skills/:id": () => ({ params: { id: ids.skill! } }),
  "/admin/api/skills/:id/versions": () => ({ params: { id: ids.skill! } }),
  "/admin/api/tool-sources/import": () => ({}),
  "/admin/api/providers": () => ({}),
  "/admin/api/providers/:id": () => ({ params: { id: ids.provider! } }),
  "/admin/api/providers/:id/models": () => ({ params: { id: ids.provider! } }),
  "/admin/api/models/:id": () => ({ params: { id: ids.model! } }),
  "/admin/api/plugins/install": () => ({}),
  "/integration/v1/runs": () => ({ auth: "connector" }),
  "/open/v1/agents/:key/runs": () => ({ params: { key: ids.agentKey! }, auth: "open" }),
  "/open/v1/agents/:key/invoke": () => ({ params: { key: ids.agentKey! }, auth: "open" }),
  "/auth/local/login": () => ({ auth: "none" }),
  // P1: action routes without a body (empty schema; closed except the external cancels).
  "/auth/logout": () => ({ auth: "none" }),
  "/admin/api/runs/:id/cancel": () => ({ params: { id: ids.run! } }),
  "/admin/api/webhook-deliveries/:id/replay": () => ({ params: { id: ids.delivery! } }),
  "/admin/api/mcp/:id/refresh": () => ({ params: { id: ids.mcp! } }),
  "/admin/api/providers/:id/test": () => ({ params: { id: ids.provider! } }),
  "/admin/api/plugins/:id/uninstall": () => ({ params: { id: ids.plugin! } }),
  "/admin/api/schedules/:id/enable": () => ({ params: { id: ids.schedule! } }),
  "/admin/api/schedules/:id/disable": () => ({ params: { id: ids.schedule! } }),
  "/admin/api/schedules/:id/run": () => ({ params: { id: ids.schedule! } }),
  "/integration/v1/runs/:id/cancel": () => ({ params: { id: ids.run! }, auth: "connector" }),
  "/open/v1/runs/:id/cancel": () => ({ params: { id: ids.run! }, auth: "open" }),
};
/** External routes whose body schema is deliberately open (architect P1); an empty open schema has no invalid body. */
const EXTERNAL_OPEN = new Set(["/integration/v1/runs", "/integration/v1/runs/:id/cancel", "/open/v1/agents/:key/runs", "/open/v1/agents/:key/invoke", "/open/v1/runs/:id/cancel"]);

/** A value every schema rejects for this property: over maxLength / maxItems, else the wrong JSON type. */
function invalidValue(schema: JsonSchema): unknown {
  // Very large limits (instructions, run input, JSON specs) are exercised with the wrong type instead: a 1 MiB+ body
  // would hit the route body limit first (413 OPN-4504).
  if (schema.maxLength !== undefined && schema.maxLength >= 65_536) return Array.isArray(schema.type) && schema.type.includes("number") ? {} : 12345;
  if (schema.maxLength !== undefined) return "9".repeat(schema.maxLength + 1);
  if (schema.maxItems !== undefined) return Array.from({ length: schema.maxItems + 1 }, () => invalidValue(schema.items ?? { type: "string" }));
  return schema.type === "string" ? 12345 : "not-the-right-type";
}

function invalidObject(schema: JsonSchema): Record<string, unknown> {
  // An empty closed schema (action routes) has no field to break: one undeclared field is the invalid body.
  if (!Object.keys(schema.properties ?? {}).length && schema.additionalProperties === false) return { __undeclared: 1 };
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, prop]) => [key, invalidValue(prop)]));
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  connectorApp = await buildApp({
    logger: false,
    config: {
      AGENT_CONNECTOR_ENABLED: true, AGENT_CONNECTOR_INBOUND_ENABLED: true, AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: false,
      AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(pair.publicKey)).toString("base64"),
      AGENT_CONNECTOR_ENVIRONMENT: "test", CONNECTOR_PRINCIPAL_ISSUER: issuer, CONNECTOR_PRINCIPAL_AUDIENCE: audience,
    },
  });
  await connectorApp.ready();
  const plain = await realSession({ name: "IT schema coverage user", role: "user", orgUnitId: ROOT, dataScope: "self" });
  userHeaders = sessionHeaders(plain, sessionCookieValue(plain));
  const pa = await realSession({ name: "IT schema coverage", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  ids.agentKey = `it-rsc-${suffix}`;
  ids.agent = await repos.createAgent({ key: ids.agentKey, name: "IT rsc", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  await repos.updateAgent(ids.agent, { api_enabled: 1 });
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
  ids.app = await repos.createApiApp({ key: `it-rsc-${suffix}`, name: "IT rsc", ownerOrgUnitId: ROOT, scopes: ["runs:create", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId: ids.app, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:create", "runs:read"] });
  ids.user = await repos.createUser({ email: `it-rsc-target-${suffix}@forge.local`, username: `it-rsc-t-${suffix}`, displayName: "IT rsc target", role: "user", dataScope: "self", orgUnitId: ROOT });
  ids.connectorUser = await repos.createUser({ email: `it-rsc-conn-${suffix}@forge.local`, username: `it-rsc-c-${suffix}`, displayName: "IT rsc conn", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-rsc-sub-${suffix}` });
  ids.mcp = await repos.createMcpServer({ key: `it-rsc-${suffix}`, name: "IT rsc", url: "https://mcp.example.com/mcp", headers: {}, createdBy: ADMIN_ID });
  ids.skill = await repos.createSkill({ key: `it-rsc-${suffix}`, name: "IT rsc", description: "", content: "# x", publish: true, createdBy: ADMIN_ID });
  ids.provider = await repos.createProvider({ key: `it-rsc-${suffix}`, name: "IT rsc", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKeyEncrypted: null, headers: {}, createdBy: ADMIN_ID });
  ids.delivery = (await repos.enqueueWebhook({ appId: ids.app, eventId: `it-rsc-${suffix}`, eventType: "run.completed", payload: {} }))!;
  ids.plugin = await repos.createPlugin({ key: `it-rsc-plg-${suffix}`, version: "1.0.0", type: "mixed", name: "IT rsc plugin", manifest: {}, resources: {}, createdBy: ADMIN_ID });
  ids.model = await repos.createModel({ providerId: ids.provider, key: `it-rsc-${suffix}`, displayName: "IT rsc", capabilities: ["text"] });
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
  if (ids.app) {
    await execute("DELETE FROM webhook_deliveries WHERE app_id = ?", [ids.app]);
    await execute("DELETE FROM api_keys WHERE app_id = ?", [ids.app]);
    await execute("DELETE FROM api_apps WHERE id = ?", [ids.app]);
  }
  if (ids.plugin) await execute("DELETE FROM plugins WHERE id = ?", [ids.plugin]);
  if (ids.model) await execute("DELETE FROM llm_models WHERE id = ?", [ids.model]);
  if (ids.provider) await execute("DELETE FROM llm_providers WHERE id = ?", [ids.provider]);
  if (ids.mcp) await execute("DELETE FROM mcp_servers WHERE id = ?", [ids.mcp]);
  if (ids.skill) {
    await execute("DELETE FROM skill_versions WHERE skill_id = ?", [ids.skill]);
    await execute("DELETE FROM skills WHERE id = ?", [ids.skill]);
  }
  await execute("DELETE FROM users WHERE email LIKE ?", [`%${suffix}%`]);
  await cleanupRealSessions();
  await app?.close();
  await connectorApp?.close();
});

function schemaRoutes(): Array<{ method: string; url: string; part: "body" | "querystring"; schema: JsonSchema }> {
  const out: Array<{ method: string; url: string; part: "body" | "querystring"; schema: JsonSchema }> = [];
  for (const route of seen) {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== "HEAD");
    for (const part of ["body", "querystring"] as const) {
      const schema = route.schema?.[part] as JsonSchema | undefined;
      if (schema) for (const method of methods) if (!out.some((r) => r.method === method && r.url === route.url && r.part === part)) out.push({ method, url: route.url, part, schema });
    }
  }
  return out;
}

type SchemaRoute = ReturnType<typeof schemaRoutes>[number];
async function send(route: SchemaRoute, who: "authorised" | "forbidden", idOverride?: string, bodyOverride?: Record<string, unknown>) {
  const fixture = FIXTURES[route.url];
  expect(fixture, `no FIXTURES entry for ${route.method} ${route.url}`).toBeDefined();
  const { params = {}, keep = {}, auth = "session" } = fixture!();
  const url = route.url.replace(/:(\w+)/g, (_, name: string) => idOverride ?? params[name] ?? `missing-${name}`);
  const invalid = bodyOverride ? { ...bodyOverride, ...keep } : { ...invalidObject(route.schema), ...keep };
  const target = auth === "connector" ? connectorApp : app;
  const h: Record<string, string> =
    auth === "open" ? { authorization: `Bearer ${openKey}` }
    : auth === "connector" ? { authorization: `Bearer ${await connectorToken()}` }
    : auth === "none" ? {}
    : who === "forbidden" ? userHeaders : headers;
  return route.part === "body"
    ? target.inject({ method: route.method as "POST", url, headers: h, payload: invalid })
    : target.inject({ method: route.method as "GET", url: `${url}?${new URLSearchParams(Object.entries(invalid).map(([k, v]) => [k, String(v)])).toString()}`, headers: h });
}

describe("every route with a body / querystring schema rejects invalid input with 400 (attachValidation backstop)", () => {
  it("the collector sees the schema routes (guards the hook itself)", () => {
    const keys = schemaRoutes().map((r) => `${r.method} ${r.url} ${r.part}`);
    expect(keys.length).toBeGreaterThanOrEqual(44);
    expect(keys).toContain("POST /admin/api/agents body");
    expect(keys).toContain("GET /admin/api/runs querystring");
  });

  it("each one answers 400 CFG-8501 to an invalid request from an authorised caller", async () => {
    const results: Array<{ route: string; status: number; code?: string }> = [];
    // The external empty schemas (integration / open run cancel) are open by ruling, so no body is invalid there.
    for (const route of schemaRoutes().filter((r) => !(EXTERNAL_OPEN.has(r.url) && !Object.keys(r.schema.properties ?? {}).length))) {
      const res = await send(route, "authorised");
      const body = res.json() as { error?: { code?: string } };
      results.push({ route: `${route.method} ${route.url} ${route.part}`, status: res.statusCode, code: body.error?.code });
    }
    expect(results.filter((r) => r.status !== 400 || r.code !== "CFG-8501")).toEqual([]);
  });

  it("P1: each admin / console body route rejects an otherwise valid body with one undeclared field: 400 CFG-8501 field=__undeclared", async () => {
    // Required fields get a valid value so the only error left is the undeclared field (rejected, not stripped).
    const REQUIRED_VALID: Record<string, unknown> = { email: `it-rsc-x-${suffix}@forge.local`, decision: "approved" };
    const routes = schemaRoutes().filter((r) => r.part === "body" && !EXTERNAL_OPEN.has(r.url));
    expect(routes.length).toBe(37);
    const wrong: string[] = [];
    for (const route of routes) {
      const required = ((route.schema as { required?: string[] }).required ?? []).map((k) => [k, REQUIRED_VALID[k]]);
      // POST /admin/api/agents checks `key` (presence and format) before the schema, so it gets a valid one.
      const before = route.url === "/admin/api/agents" ? { key: `it-rsc-x-${suffix}` } : {};
      const res = await send(route, "authorised", undefined, { ...Object.fromEntries(required), ...before, __undeclared: 1 });
      const error = (res.json() as { error?: { code?: string; details?: { field?: string } } }).error;
      if (res.statusCode !== 400 || error?.code !== "CFG-8501" || error.details?.field !== "__undeclared") wrong.push(`${route.method} ${route.url}: ${res.statusCode} ${error?.code ?? ""} ${error?.details?.field ?? ""}`);
    }
    expect(wrong).toEqual([]);
  });

  it("F1: 403 before 400 - a session without the permission gets 403 POL-2001 for the same invalid body", async () => {
    // role "user" holds agent.view / agent.run / run.view only, so agents/:id/run is checked for 400 above, not here.
    const routes = schemaRoutes().filter((r) => r.part === "body" && r.url.startsWith("/admin/api/") && r.url !== "/admin/api/agents/:id/run");
    expect(routes.length).toBeGreaterThanOrEqual(25);
    const wrong: string[] = [];
    for (const route of routes) {
      const res = await send(route, "forbidden");
      const code = (res.json() as { error?: { code?: string } }).error?.code;
      if (res.statusCode !== 403) wrong.push(`${route.method} ${route.url}: ${res.statusCode} ${code ?? ""}`);
    }
    expect(wrong).toEqual([]);
  });

  it("F1: an over-long path id is 404 (not 400) even with an invalid body", async () => {
    const routes = schemaRoutes().filter((r) => /:(id|key)\b/.test(r.url));
    expect(routes.length).toBeGreaterThanOrEqual(17);
    const wrong: string[] = [];
    for (const route of routes) {
      const res = await send(route, "authorised", "x".repeat(300));
      if (res.statusCode !== 404) wrong.push(`${route.method} ${route.url}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });
});
