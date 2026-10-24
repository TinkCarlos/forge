import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (frontend report, needs a *_test DB): agent PATCH stored `apiEnabled: "yes"` as api_enabled = 1 (the agentPatch
// schema from 44f7a55 did not declare apiEnabled, so `body.apiEnabled ? 1 : 0` took any truthy value). Same gap for
// agent create publish/spec and schedule create enabled/input. Non-booleans -> 400 CFG-8501 with details.field,
// nothing stored; real booleans keep working.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let accountId = "";

const apiEnabled = async () => Number((await one<{ api_enabled: number }>("SELECT api_enabled FROM agents WHERE id = ?", [agentId]))!.api_enabled);
const field = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string; details?: { field?: string } } }).error;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT bbf", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-bbf-${suffix}`, name: "IT bbf", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  const versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  accountId = await repos.createServiceAccount({ key: `it-bbf-svc-${suffix}`, name: "IT bbf svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type IN ('agent', 'agent_version') AND resource_id IN (SELECT id FROM agents WHERE `key` LIKE ?)", [`it-bbf-%${suffix}`]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'schedule' AND resource_id IN (SELECT id FROM schedules WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM schedules WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE `key` LIKE ?)", [`it-bbf-%${suffix}`]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [`it-bbf-%${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("boolean body fields are booleans", () => {
  it("agent PATCH apiEnabled: 'yes' / 'true' / 1 / null -> 400 field apiEnabled, unchanged; false / true stored", async () => {
    await execute("UPDATE agents SET api_enabled = 0 WHERE id = ?", [agentId]);
    for (const value of ["yes", "true", 1, null]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers, payload: { apiEnabled: value } });
      expect([JSON.stringify(value), res.statusCode]).toEqual([JSON.stringify(value), 400]);
      expect(field(res)).toMatchObject({ code: "CFG-8501", details: { field: "apiEnabled" } });
      expect(await apiEnabled()).toBe(0);
    }
    expect((await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers, payload: { apiEnabled: true } })).statusCode).toBe(200);
    expect(await apiEnabled()).toBe(1);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers, payload: { apiEnabled: false } })).statusCode).toBe(200);
    expect(await apiEnabled()).toBe(0);
  });

  it("agent create publish: 'yes' -> 400 field publish; spec must be object or JSON text", async () => {
    const bad = await app.inject({ method: "POST", url: "/admin/api/agents", headers, payload: { key: `it-bbf-a-${suffix}`, name: "x", publish: "yes" } });
    expect([bad.statusCode, field(bad)?.details?.field]).toEqual([400, "publish"]);
    const badSpec = await app.inject({ method: "POST", url: "/admin/api/agents", headers, payload: { key: `it-bbf-b-${suffix}`, name: "x", spec: 42 } });
    expect([badSpec.statusCode, field(badSpec)?.details?.field]).toEqual([400, "spec"]);
    const ok = await app.inject({ method: "POST", url: "/admin/api/agents", headers, payload: { key: `it-bbf-c-${suffix}`, name: "x", publish: true } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("schedule create enabled: 'true' -> 400 field enabled; input must be object or JSON text", async () => {
    const base = { agentId, serviceAccountId: accountId, cron: "0 9 * * *" };
    const bad = await app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { ...base, key: `it-bbf-s1-${suffix}`, enabled: "true" } });
    expect([bad.statusCode, field(bad)?.details?.field]).toEqual([400, "enabled"]);
    const badInput = await app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { ...base, key: `it-bbf-s2-${suffix}`, input: 5 } });
    expect([badInput.statusCode, field(badInput)?.details?.field]).toEqual([400, "input"]);
    const ok = await app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { ...base, key: `it-bbf-s3-${suffix}`, enabled: true, input: { text: "hi" } } });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
