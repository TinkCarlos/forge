import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { buildApp } from "../apps/api/src/app.js";
import { installErrorHandler } from "../apps/api/src/plugins/errors.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1-10 / S-25 / K-08 (needs a *_test DB): a unique-key collision is 409 CFG-8503, never 500, and the response
// carries no SQL, table, index or the duplicated value. No success audit, no new row.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let accountId = "";
let providerId = "";
let skillId = "";

type Res = { statusCode: number; body: string; json: () => unknown };
function expect409(res: Res, dupValue: string): void {
  expect(res.statusCode, res.body).toBe(409);
  expect((res.json() as { error: { code: string } }).error.code).toBe("CFG-8503");
  for (const leak of ["Duplicate", "uk_", "idx_", "INSERT", "ER_DUP_ENTRY", dupValue]) expect(res.body).not.toContain(leak);
}
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
const count = async (sql: string, params: unknown[]) => Number((await query<{ n: number }>(sql, params))[0]!.n);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const session = await realSession({ name: "IT dup", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  agentId = await repos.createAgent({ key: `it-dup-${suffix}`, name: "IT dup", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  const versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  accountId = await repos.createServiceAccount({ key: `it-dup-svc-${suffix}`, name: "IT dup svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  providerId = await repos.createProvider({ key: `it-dup-${suffix}`, name: "IT dup", protocol: "openai", baseUrl: "https://example.com/v1" });
  skillId = await repos.createSkill({ key: `it-dup-${suffix}`, name: "IT dup", content: "# x", version: "1.0.0", publish: false });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE details_json LIKE ? OR resource_id IN (SELECT id FROM agents WHERE `key` LIKE ?)", [`%${suffix}%`, `%${suffix}%`]);
  await execute("DELETE FROM schedules WHERE `key` LIKE ?", [`%${suffix}%`]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE `key` LIKE ?)", [`%${suffix}%`]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [`%${suffix}%`]);
  await execute("DELETE FROM api_apps WHERE `key` LIKE ?", [`%${suffix}%`]);
  await execute("DELETE FROM users WHERE email LIKE ?", [`%${suffix}%`]);
  await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
  await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  await execute("UPDATE skills SET latest_version_id = NULL, published_version_id = NULL WHERE id = ?", [skillId]);
  await execute("DELETE FROM skill_versions WHERE skill_id = ?", [skillId]);
  await execute("DELETE FROM skills WHERE id = ?", [skillId]);
  await cleanupRealSessions();
  await app.close();
});

describe("duplicate key -> 409 CFG-8503", () => {
  it("I-AGT-07: same agent version twice", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM agent_versions WHERE agent_id = ?", [agentId]);
    expect409(await post(`/admin/api/agents/${agentId}/versions`, { version: "1.0.0" }), "1.0.0");
    expect(await count("SELECT COUNT(*) AS n FROM agent_versions WHERE agent_id = ?", [agentId])).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'agent.version.create' AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentId')) = ?", [agentId])).toBe(0);
  });
  it("I-APP-01: same app key twice", async () => {
    const key = `it-dup-app-${suffix}`;
    expect((await post("/admin/api/apps", { key })).statusCode).toBe(200);
    expect409(await post("/admin/api/apps", { key }), key);
    expect(await count("SELECT COUNT(*) AS n FROM api_apps WHERE `key` = ?", [key])).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'app.create' AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.key')) = ?", [key])).toBe(1);
  });
  it("I-SCH-06: same schedule key twice", async () => {
    const key = `it-dup-sch-${suffix}`;
    const body = { key, name: "dup", agentId, serviceAccountId: accountId, cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" } };
    const first = await post("/admin/api/schedules", body);
    expect(first.statusCode, first.body).toBe(200);
    expect409(await post("/admin/api/schedules", body), key);
    expect(await count("SELECT COUNT(*) AS n FROM schedules WHERE `key` = ?", [key])).toBe(1);
  });
  it("I-USR-04: same username, different email", async () => {
    const username = `it-dup-u-${suffix}`;
    expect((await post("/admin/api/users", { email: `a-${suffix}@forge.local`, username })).statusCode).toBe(200);
    expect409(await post("/admin/api/users", { email: `b-${suffix}@forge.local`, username }), username);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE email = ?", [`b-${suffix}@forge.local`])).toBe(0);
  });
  it("I-AGT-03: two concurrent creates with the same agent key -> one 200, one 409", async () => {
    const key = `it-dup-c-${suffix}`;
    const results = await Promise.all([post("/admin/api/agents", { key }), post("/admin/api/agents", { key })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect((loser.json() as { error: { code: string } }).error.code).toBe("CFG-8503");
    expect(await count("SELECT COUNT(*) AS n FROM agents WHERE `key` = ?", [key])).toBe(1);
  });
  it("S-25: same skill version and same model key", async () => {
    expect409(await post(`/admin/api/skills/${skillId}/versions`, { version: "1.0.0", content: "# y" }), "1.0.0");
    const key = `it-dup-m-${suffix}`;
    expect((await post(`/admin/api/providers/${providerId}/models`, { key })).statusCode).toBe(200);
    expect409(await post(`/admin/api/providers/${providerId}/models`, { key }), key);
  });
  it("errorHandler: the log keeps the driver code, the response does not", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const probe = Fastify({ logger: { level: "info", stream } });
    installErrorHandler(probe);
    probe.get("/dup", async () => {
      throw Object.assign(new Error("Duplicate entry 'secret-value' for key 'uk_users_username'"), { code: "ER_DUP_ENTRY", errno: 1062, sql: "INSERT INTO users ..." });
    });
    const res = await probe.inject({ method: "GET", url: "/dup" });
    expect409(res, "secret-value");
    expect(lines.join("\n")).toContain("ER_DUP_ENTRY");
    await probe.close();
  });
});
