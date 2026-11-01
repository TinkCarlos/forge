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

// Item 9 (needs a *_test DB): a run request with both `text` and an object `input` that has no `text` key used to store
// the user message as "[object Object]" (String(input)). Now every run entry (admin, open runs / invoke, integration)
// answers 400 CFG-8501 (details.field = "text"), creating no Run and no audit. `input` alone (with or without a text
// key) and `text` alone still work; an object input without a text key is stored as its JSON text, never "[object Object]".
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-itc";
const audience = "forge-itc";
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
const connectorToken = () =>
  new SignJWT({ principalType: "user", application: "itc", environment: "test", roles: [], subject: `it-itc-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

type Payload = Record<string, unknown>;
const entries: Array<{ name: string; call: (payload: Payload) => Promise<LightMyRequestResponse> }> = [
  { name: "admin POST /admin/api/agents/:id/run", call: async (payload) => app.inject({ method: "POST", url: `/admin/api/agents/${agentId}/run`, headers: await configurationHeaders(`/admin/api/agents/${agentId}/run`, headers), payload }) },
  { name: "open POST /open/v1/agents/:key/runs", call: (payload) => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: { authorization: `Bearer ${openKey}` }, payload }) },
  { name: "open POST /open/v1/agents/:key/invoke", call: (payload) => app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/invoke?wait=0`, headers: { authorization: `Bearer ${openKey}` }, payload }) },
  { name: "integration POST /integration/v1/runs", call: async (payload) => connectorApp.inject({ method: "POST", url: "/integration/v1/runs", headers: { authorization: `Bearer ${await connectorToken()}` }, payload: { agentKey, ...payload } }) },
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
  agentKey = `it-itc-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT itc", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  await repos.updateAgent(agentId, { api_enabled: 1 }, { expectedRevision: "system" });
  appId = await repos.createApiApp({ key: `it-itc-${suffix}`, name: "IT itc", ownerOrgUnitId: ROOT, scopes: ["runs:create", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:create", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-itc-${suffix}@forge.local`, username: `it-itc-${suffix}`, displayName: "IT", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-itc-sub-${suffix}` });
});

afterAll(async () => {
  await execute("UPDATE runs SET status = 'cancelled' WHERE agent_id = ? AND status IN ('queued','running')", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  for (const table of ["messages", "run_events", "run_steps"]) await execute(`DELETE x FROM ${table} x JOIN runs r ON r.id = x.run_id WHERE r.agent_id = ?`, [agentId]);
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

const errorDetails = (res: LightMyRequestResponse) => (res.json() as { error: { details?: { field?: string } } }).error.details;
const userMessages = async () => (await query<{ content_json: unknown }>("SELECT m.content_json FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.agent_id = ? AND m.role = 'user'", [agentId])).map((r) => JSON.stringify(r.content_json));

describe("item 9: text + object input without a text key -> 400", () => {
  for (const entry of entries) {
    it(`${entry.name}: 400 CFG-8501, no Run, no audit`, async () => {
      const runsBefore = await runCount();
      const auditsBefore = await auditCount();
      const res = await entry.call({ text: "hi", input: { foo: 1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe("CFG-8501");
      expect(errorDetails(res)?.field).toBe("text");
      expect(await runCount()).toBe(runsBefore);
      expect(await auditCount()).toBe(auditsBefore);
    });
  }

  it("text alone, input with a text key, and text + input with a text key still run; no message is [object Object]", async () => {
    for (const entry of entries) {
      for (const payload of [{ text: "hi" }, { input: { text: "hi" } }, { text: "hi", input: { text: "hello" } }, { input: { foo: 1 } }]) {
        const res = await entry.call(payload);
        expect([200, 201, 202], `${entry.name} ${JSON.stringify(payload)}: ${res.body}`).toContain(res.statusCode);
      }
    }
    const messages = await userMessages();
    expect(messages.length).toBeGreaterThanOrEqual(16);
    expect(messages.join("\n")).not.toContain("[object Object]");
    expect(messages.some((m) => m.includes("foo"))).toBe(true);
  });
});

describe("item 9 adjusted: only a non-empty (after trim) text conflicts with an input object without a text key", () => {
  const latestInput = async () => (await query<{ input_json: unknown }>("SELECT input_json FROM runs WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [agentId]))[0]?.input_json;
  for (const entry of entries) {
    it(`${entry.name}: text "" / blank + input object -> Run with that input (positive)`, async () => {
      for (const [i, text] of ["", "   "].entries()) {
        const marker = `${entry.name}-${i}`;
        const runsBefore = await runCount();
        const res = await entry.call({ text, input: { marker } });
        expect([200, 201, 202], `${JSON.stringify(text)}: ${res.body}`).toContain(res.statusCode);
        expect(await runCount()).toBe(runsBefore + 1);
        const stored = await latestInput();
        expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual({ marker });
      }
    });

    it(`${entry.name}: padded non-empty text + input object -> 400 CFG-8501, no Run (negative)`, async () => {
      const runsBefore = await runCount();
      const res = await entry.call({ text: "  hi  ", input: { foo: 1 } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe("CFG-8501");
      expect(errorDetails(res)?.field).toBe("text");
      expect(await runCount()).toBe(runsBefore);
    });
  }
});
