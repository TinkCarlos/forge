import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Y: audit actions auth.logout (#9), schedule.enable (#47), schedule.disable (#48), open.run.cancel (#79),
// integration.run.create (#83), integration.run.cancel (#86). Failed calls write nothing.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-audit-y";
const audience = "forge-audit-y";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let headers: Record<string, string> = {};
let agentId = "";
let agentKey = "";
let versionId = "";
let threadId = "";
let appId = "";
let openKey = "";
let connectorUserId = "";
let scheduleId = "";

type Audit = { actor_type: string; actor_id: string | null; resource_type: string; resource_id: string | null; details_json: unknown };
const audits = (action: string, resourceId: string) =>
  query<Audit>("SELECT actor_type, actor_id, resource_type, resource_id, details_json FROM audit_logs WHERE action = ? AND resource_id = ?", [action, resourceId]);
const token = () =>
  new SignJWT({ principalType: "user", application: "audit-y", environment: "test", roles: [], subject: `it-ay-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const makeRun = (status: string, withApp = true) =>
  repos.createRun({ threadId, agentId, agentVersionId: versionId, appId: withApp ? appId : null, orgUnitId: ROOT, subjectType: "user", subjectId: connectorUserId, input: { text: "x" }, status });

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
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentKey = `it-ay-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT audit y", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  appId = await repos.createApiApp({ key: `it-ay-${suffix}`, name: "IT audit y", ownerOrgUnitId: ROOT, scopes: ["runs:cancel", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:cancel", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-ay-${suffix}@forge.local`, username: `it-ay-${suffix}`, displayName: "IT ay", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-ay-sub-${suffix}` });
  threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: connectorUserId });
  scheduleId = await repos.createSchedule({ key: `it-ay-sch-${suffix}`, name: "IT ay", agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", createdBy: ADMIN_ID });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_id = ?", [scheduleId]);
  await execute("DELETE FROM schedules WHERE id = ?", [scheduleId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
  await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  await execute("DELETE FROM audit_logs WHERE resource_id = ?", [connectorUserId]);
  await execute("DELETE FROM users WHERE id = ?", [connectorUserId]);
  await cleanupRealSessions();
  await app?.close();
  await connectorApp?.close();
});

describe("audit actions (Y)", () => {
  it("#9 auth.logout: written for a real session, not for an anonymous logout", async () => {
    const s = await realSession({ role: "operator", orgUnitId: ROOT, dataScope: "org" });
    const res = await app.inject({ method: "POST", url: "/auth/logout", headers: sessionHeaders(s, sessionCookieValue(s)) });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await audits("auth.logout", s.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: s.userId, resource_type: "user" });
    const before = (await query("SELECT id FROM audit_logs WHERE action = 'auth.logout'")).length;
    expect((await app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(200);
    expect((await query("SELECT id FROM audit_logs WHERE action = 'auth.logout'")).length).toBe(before);
    await execute("DELETE FROM audit_logs WHERE action = 'auth.logout' AND resource_id = ?", [s.userId]);
  });

  it("#47 / #48 schedule.enable and schedule.disable", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/api/schedules/${scheduleId}/enable`, headers, payload: {} })).statusCode).toBe(200);
    expect(await audits("schedule.enable", scheduleId)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/admin/api/schedules/${scheduleId}/disable`, headers, payload: {} })).statusCode).toBe(200);
    const rows = await audits("schedule.disable", scheduleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", resource_type: "schedule" });
  });

  it("#79 open.run.cancel: written on success (actor = app), not on 409", async () => {
    const runId = await makeRun("queued");
    const res = await app.inject({ method: "POST", url: `/open/v1/runs/${runId}/cancel`, headers: { authorization: `Bearer ${openKey}` }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await audits("open.run.cancel", runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "app", actor_id: appId, resource_type: "run" });
    const done = await makeRun("succeeded");
    expect((await app.inject({ method: "POST", url: `/open/v1/runs/${done}/cancel`, headers: { authorization: `Bearer ${openKey}` }, payload: {} })).statusCode).toBe(409);
    expect(await audits("open.run.cancel", done)).toHaveLength(0);
  });

  it("#83 integration.run.create: actor = mapped user", async () => {
    const res = await connectorApp.inject({ method: "POST", url: "/integration/v1/runs", headers: { authorization: `Bearer ${await token()}` }, payload: { agentKey, text: "hi" } });
    expect(res.statusCode, res.body).toBe(202);
    const runId = (res.json() as { runId: string }).runId;
    const rows = await audits("integration.run.create", runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: connectorUserId, resource_type: "run" });
  });

  it("#86 integration.run.cancel: written on success, not on 409", async () => {
    const runId = await makeRun("queued", false);
    const res = await connectorApp.inject({ method: "POST", url: `/integration/v1/runs/${runId}/cancel`, headers: { authorization: `Bearer ${await token()}` }, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await audits("integration.run.cancel", runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: connectorUserId, resource_type: "run" });
    const done = await makeRun("failed", false);
    expect((await connectorApp.inject({ method: "POST", url: `/integration/v1/runs/${done}/cancel`, headers: { authorization: `Bearer ${await token()}` }, payload: {} })).statusCode).toBe(409);
    expect(await audits("integration.run.cancel", done)).toHaveLength(0);
  });
});
