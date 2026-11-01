import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// #79 / I-RUN-06: cancelling a Run that already finished is 409 RUN-7005 on all three entries (admin, open,
// integration); status unchanged, no cancel audit. A Run that is still queued can be cancelled as before.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-cancel";
const audience = "forge-cancel";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let threadId = "";
let appId = "";
let openKey = "";
let connectorUserId = "";

const makeRun = (status: string) =>
  repos.createRun({ threadId, agentId, agentVersionId: versionId, appId, orgUnitId: ROOT, subjectType: "user", subjectId: connectorUserId, input: { text: "x" }, status });
const token = () =>
  new SignJWT({ principalType: "user", application: "cancel", environment: "test", roles: [], subject: `it-cancel-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const entries: Array<{ name: string; cancel: (runId: string) => Promise<LightMyRequestResponse> }> = [
  { name: "admin", cancel: (id) => app.inject({ method: "POST", url: `/admin/api/runs/${id}/cancel`, headers, payload: {} }) },
  { name: "open", cancel: (id) => app.inject({ method: "POST", url: `/open/v1/runs/${id}/cancel`, headers: { authorization: `Bearer ${openKey}` }, payload: {} }) },
  { name: "integration", cancel: async (id) => connectorApp.inject({ method: "POST", url: `/integration/v1/runs/${id}/cancel`, headers: { authorization: `Bearer ${await token()}` }, payload: {} }) },
];
const cancelAudits = async (runId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE outcome = 'success' AND action = 'run.cancel' AND resource_id = ?", [runId]))[0]!.n;

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
  agentId = await repos.createAgent({ key: `it-cancel-${suffix}`, name: "IT cancel", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  appId = await repos.createApiApp({ key: `it-cancel-${suffix}`, name: "IT cancel", ownerOrgUnitId: ROOT, scopes: ["runs:cancel", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:cancel", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-cancel-${suffix}@forge.local`, username: `it-cancel-${suffix}`, displayName: "IT", role: "operator", dataScope: "self", orgUnitId: ROOT, idpSubject: `it-cancel-sub-${suffix}` });
  threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: connectorUserId });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]).catch(() => undefined);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
  await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  await execute("DELETE FROM users WHERE id = ?", [connectorUserId]);
  await cleanupRealSessions();
  await app?.close();
  await connectorApp?.close();
});

describe("cancel a finished Run -> 409 on every entry (#79, I-RUN-06)", () => {
  for (const status of ["succeeded", "failed", "cancelled", "budget_exhausted"]) {
    for (const entry of entries) {
      it(`${entry.name}: ${status} -> 409 RUN-7005, unchanged, no audit`, async () => {
        const runId = await makeRun(status);
        const res = await entry.cancel(runId);
        expect(res.statusCode, res.body).toBe(409);
        expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "RUN-7005", message: "Run 已结束，不能取消" });
        expect((await repos.getRun(runId))!.status).toBe(status);
        expect(await cancelAudits(runId)).toBe(0);
      });
    }
  }

  for (const entry of entries) {
    it(`${entry.name}: queued Run can still be cancelled`, async () => {
      const runId = await makeRun("queued");
      const res = await entry.cancel(runId);
      expect(res.statusCode, res.body).toBe(200);
      expect((await repos.getRun(runId))!.status).toBe("cancelled");
      // the response reports the real status, never the misleading "cancelling"
      expect(res.body).not.toContain("cancelling");
      // second cancel: now finished -> 409
      expect((await entry.cancel(runId)).statusCode).toBe(409);
    });
  }
});
