import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (architect on e2d2c5f, item 2): a Key's scopes used to be a snapshot of the app's scopes at key creation
// (admin/apps.ts:139), so narrowing the app did nothing for existing keys. The effective scope of a request is now
// Key scopes ∩ the app's *current* scopes, read on every request: narrowing takes effect on the next request,
// widening never widens an old key. No data change: api_keys.scopes_json stays byte-for-byte the same (SC-05).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const FAKE_RUN = "01J0000000000000000000ZZZZ";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let agentKey = "";
let versionId = "";
const appIds: string[] = [];

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string } }).error;
const runCount = async (appId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE app_id = ?", [appId]))[0]!.n;
const auditCount = async (appId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_type = 'app' AND actor_id = ?", [appId]))[0]!.n;
const keyScopesRaw = async (appId: string) =>
  query<{ id: string; raw: string }>("SELECT id, HEX(CAST(scopes_json AS CHAR CHARACTER SET utf8mb4)) AS raw FROM api_keys WHERE app_id = ? ORDER BY id", [appId]);

async function makeApp(name: string, appScopes: string[], keyScopes: string[]): Promise<{ appId: string; key: string }> {
  const appId = await repos.createApiApp({ key: `it-ksi-${name}-${suffix}`, name: `IT ksi ${name}`, ownerOrgUnitId: ROOT, scopes: appScopes });
  appIds.push(appId);
  const key = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: key.slice(0, 16), keyHash: hashApiKey(key, config.API_KEY_PEPPER), scopes: keyScopes });
  return { appId, key };
}
const patchScopes = async (appId: string, scopes: string[]) => {
  const res = await app.inject({ method: "PATCH", url: `/admin/api/apps/${appId}`, headers, payload: { scopes } });
  expect(res.statusCode, res.body).toBe(200);
};
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const listAgents = (key: string) => app.inject({ method: "GET", url: "/open/v1/agents", headers: bearer(key) });
const createRun = (key: string) => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: bearer(key), payload: { text: "hi" } });

/** Every scope-protected /open route (openapi.json is public). */
const protectedCalls = (key: string): Array<[string, () => Promise<LightMyRequestResponse>]> => [
  ["GET /open/v1/agents", () => listAgents(key)],
  ["GET /open/v1/agents/:key", () => app.inject({ method: "GET", url: `/open/v1/agents/${agentKey}`, headers: bearer(key) })],
  ["POST /open/v1/agents/:key/runs", () => createRun(key)],
  ["POST /open/v1/agents/:key/invoke", () => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/invoke?wait=0`, headers: bearer(key), payload: { text: "hi" } })],
  ["GET /open/v1/runs/:id", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}`, headers: bearer(key) })],
  ["GET /open/v1/runs/:id/result", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}/result`, headers: bearer(key) })],
  ["GET /open/v1/runs/:id/events", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}/events`, headers: bearer(key) })],
  ["POST /open/v1/runs/:id/cancel", () => app.inject({ method: "POST", url: `/open/v1/runs/${FAKE_RUN}/cancel`, headers: bearer(key) })],
];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const admin = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(admin, sessionCookieValue(admin));
  agentKey = `it-ksi-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT ksi", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  await repos.updateAgent(agentId, { api_enabled: 1 });
});

afterAll(async () => {
  await execute("UPDATE runs SET status = 'cancelled' WHERE agent_id = ? AND status IN ('queued','running')", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'agent' AND resource_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  for (const appId of appIds) {
    await execute("DELETE FROM audit_logs WHERE resource_id = ? OR resource_id IN (SELECT id FROM api_keys WHERE app_id = ?)", [appId, appId]);
    await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("P2 effective scope = Key scopes ∩ app's current scopes", () => {
  it("normal intersection passes: Key {agents:read, runs:create} on app {agents:read, runs:create} -> 200 / 202", async () => {
    const { appId, key } = await makeApp("ok", ["agents:read", "runs:create"], ["agents:read", "runs:create"]);
    expect((await listAgents(key)).statusCode).toBe(200);
    const res = await createRun(key);
    expect(res.statusCode, res.body).toBe(202);
    expect(await runCount(appId)).toBe(1);
  });

  it("SC-01 app narrowed {A,B} -> {A}: needs-B route 403 POL-2001 at once, needs-A route still 200", async () => {
    const { appId, key } = await makeApp("narrow", ["agents:read", "runs:create"], ["agents:read", "runs:create"]);
    await patchScopes(appId, ["agents:read"]);
    const denied = await createRun(key);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(errorOf(denied).code).toBe("POL-2001");
    expect(errorOf(denied).message).toContain("runs:create");
    expect(await runCount(appId)).toBe(0);
    expect((await listAgents(key)).statusCode).toBe(200);
  });

  it("SC-02 app widened {A} -> {A,B}: an old Key {A} does not gain B (403, no Run)", async () => {
    const { appId, key } = await makeApp("widen", ["agents:read"], ["agents:read"]);
    await patchScopes(appId, ["agents:read", "runs:create"]);
    const denied = await createRun(key);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(errorOf(denied).code).toBe("POL-2001");
    expect(await runCount(appId)).toBe(0);
    expect((await listAgents(key)).statusCode).toBe(200);
  });

  it("SC-03 empty intersection: every protected /open route 403 POL-2001, no Run, no app audit row", async () => {
    const all = ["agents:read", "runs:create", "runs:read", "runs:cancel"];
    const { appId, key } = await makeApp("empty", all, ["agents:read", "runs:create", "runs:read"]);
    await patchScopes(appId, ["runs:cancel"]);
    const auditsBefore = await auditCount(appId);
    for (const [name, call] of protectedCalls(key)) {
      const res = await call();
      expect(res.statusCode, `${name}: ${res.body}`).toBe(403);
      expect(errorOf(res).code, name).toBe("POL-2001");
    }
    expect(await runCount(appId)).toBe(0);
    expect(await auditCount(appId)).toBe(auditsBefore);
  });

  it("SC-04 no cache: each app scopes change applies to the very next request (narrow, restore, narrow)", async () => {
    const { appId, key } = await makeApp("nocache", ["agents:read", "runs:create"], ["agents:read", "runs:create"]);
    expect((await listAgents(key)).statusCode).toBe(200);
    await patchScopes(appId, ["runs:create"]);
    expect((await listAgents(key)).statusCode).toBe(403);
    await patchScopes(appId, ["agents:read", "runs:create"]);
    expect((await listAgents(key)).statusCode).toBe(200);
    await patchScopes(appId, []);
    expect((await listAgents(key)).statusCode).toBe(403);
  });

  it("SC-05 no data change: api_keys.scopes_json is byte-identical before and after narrowing / widening the app", async () => {
    const { appId, key } = await makeApp("bytes", ["agents:read", "runs:create"], ["agents:read", "runs:create"]);
    const before = await keyScopesRaw(appId);
    expect(before).toHaveLength(1);
    await patchScopes(appId, ["agents:read"]);
    await createRun(key);
    await listAgents(key);
    await patchScopes(appId, ["agents:read", "runs:create", "runs:read", "runs:cancel"]);
    await listAgents(key);
    expect(await keyScopesRaw(appId)).toEqual(before);
  });

  it("SC-06 new Key via admin API is unchanged: stores the app's scopes at creation and works within them", async () => {
    const { appId } = await makeApp("newkey", ["agents:read"], ["agents:read"]);
    const created = await app.inject({ method: "POST", url: `/admin/api/apps/${appId}/keys`, headers, payload: { name: "fresh" } });
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json() as { id: string; key: string; prefix: string };
    expect(body.key.startsWith("fsk_")).toBe(true);
    const row = (await query<{ scopes_json: unknown }>("SELECT scopes_json FROM api_keys WHERE id = ?", [body.id]))[0]!;
    expect(row.scopes_json).toEqual(["agents:read"]);
    expect((await listAgents(body.key)).statusCode).toBe(200);
    expect((await createRun(body.key)).statusCode).toBe(403);
  });
});
