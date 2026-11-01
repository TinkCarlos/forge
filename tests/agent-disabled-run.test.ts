import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// I-AGT-11 / 11b / 11c: a disabled Agent (status != active) cannot be run from admin, open or integration:
// 409 CFG-8503「Agent 已停用，不能运行」, no Run, no audit. Agent status only accepts active / disabled (else 400 CFG-8501).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-agt-off";
const audience = "forge-agt-off";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let headers: Record<string, string> = {};
let agentId = "";
let agentKey = "";
let versionId = "";
let appId = "";
let openKey = "";
let connectorUserId = "";

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string } }).error;
const runCount = async () => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?", [agentId]))[0]!.n;
const auditCount = async () =>
  (await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('run.create','open.run.create') AND (JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentId')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentKey')) = ?)", [agentId, agentKey]))[0]!.n;
const setStatus = (status: string) => execute("UPDATE agents SET status = ? WHERE id = ?", [status, agentId]);
const connectorToken = () =>
  new SignJWT({ principalType: "user", application: "agt-off", environment: "test", roles: [], subject: `it-agt-off-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

const entries: Array<{ name: string; call: () => Promise<LightMyRequestResponse> }> = [
  { name: "admin POST /admin/api/agents/:id/run", call: async () => app.inject({ method: "POST", url: `/admin/api/agents/${agentId}/run`, headers: await configurationHeaders(`/admin/api/agents/${agentId}/run`, headers), payload: { text: "hi" } }) },
  { name: "open POST /open/v1/agents/:key/runs", call: () => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: { authorization: `Bearer ${openKey}` }, payload: { text: "hi" } }) },
  { name: "open POST /open/v1/agents/:key/invoke", call: () => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/invoke?wait=0`, headers: { authorization: `Bearer ${openKey}` }, payload: { text: "hi" } }) },
  { name: "integration POST /integration/v1/runs", call: async () => connectorApp.inject({ method: "POST", url: "/integration/v1/runs", headers: { authorization: `Bearer ${await connectorToken()}` }, payload: { agentKey, text: "hi" } }) },
];

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
  const admin = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(admin, sessionCookieValue(admin));
  agentKey = `it-agt-off-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT agent off", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  await repos.updateAgent(agentId, { api_enabled: 1 }, { expectedRevision: "system" });
  appId = await repos.createApiApp({ key: `it-agt-off-${suffix}`, name: "IT agt off", ownerOrgUnitId: ROOT, scopes: ["runs:create", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:create", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-agt-off-${suffix}@forge.local`, username: `it-agt-off-${suffix}`, displayName: "IT", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-agt-off-sub-${suffix}` });
});

afterAll(async () => {
  await execute("UPDATE runs SET status = 'cancelled' WHERE agent_id = ? AND status IN ('queued','running')", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'agent' AND resource_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
  await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  await execute("DELETE FROM users WHERE id = ?", [connectorUserId]);
  await cleanupRealSessions();
  await app?.close();
  await connectorApp?.close();
});

describe("disabled Agent cannot be run (I-AGT-11, 11b, 11c)", () => {
  for (const status of ["disabled", "archived"]) {
    for (const entry of entries) {
      it(`${entry.name}: status=${status} -> 409 CFG-8503, no Run, no audit`, async () => {
        await setStatus(status);
        const runsBefore = await runCount();
        const auditsBefore = await auditCount();
        let res: LightMyRequestResponse;
        try {
          res = await entry.call();
        } finally {
          await setStatus("active");
        }
        expect(res.statusCode, res.body).toBe(409);
        expect(errorOf(res)).toMatchObject({ code: "CFG-8503", message: "Agent 已停用，不能运行" });
        expect(await runCount()).toBe(runsBefore);
        expect(await auditCount()).toBe(auditsBefore);
      });
    }
  }

  it("active Agent still runs from every entry", async () => {
    for (const entry of entries) {
      const res = await entry.call();
      expect([200, 202], `${entry.name}: ${res.body}`).toContain(res.statusCode);
    }
  });
});

describe("Agent status accepts only active / disabled", () => {
  for (const status of ["archived", "deleted", "ACTIVE", "", "paused"]) {
    it(`PATCH status=${JSON.stringify(status)} -> 400 CFG-8501, unchanged`, async () => {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers: await configurationHeaders(`/admin/api/agents/${agentId}`, headers), payload: { status } });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe("CFG-8501");
      expect((await repos.getAgent(agentId))!.status).toBe("active");
    });
  }
  it("PATCH status with a non-string -> 400 CFG-8501", async () => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers: await configurationHeaders(`/admin/api/agents/${agentId}`, headers), payload: { status: 1 } });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
  });
  it("PATCH status=disabled then active -> 200", async () => {
    for (const status of ["disabled", "active"]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers: await configurationHeaders(`/admin/api/agents/${agentId}`, headers), payload: { status } });
      expect(res.statusCode).toBe(200);
      expect((await repos.getAgent(agentId))!.status).toBe(status);
    }
  });
});
