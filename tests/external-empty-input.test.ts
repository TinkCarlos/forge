import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item E (needs a *_test DB): /open runs / invoke and /integration runs with an empty input used to queue a Run with
// input {"text":""}. Empty = text missing, null, "" or blank after trim, AND input missing, null or {} (also as JSON text
// "{}"). Both empty -> 400 CFG-8501「缺少字段: text 或 input」, no Run, no audit. One non-empty side runs as before: a
// blank text or an empty input is then simply ignored (so text "" + input {foo:1} is no longer the item-9 conflict on these
// two entries). An input object whose only key is text with a null / "" / blank value is empty too; any other key makes it
// non-empty. input must be an object: [] (array or JSON text "[]") is a 400 CFG-8501 shape error, no Run. A multipart request has no parsed fields (body empty) and goes through the same check.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-eei";
const audience = "forge-eei";
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
  new SignJWT({ principalType: "user", application: "eei", environment: "test", roles: [], subject: `it-eei-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

type Payload = Record<string, unknown>;
const entries: Array<{ name: string; call: (payload: Payload) => Promise<LightMyRequestResponse> }> = [
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
  agentKey = `it-eei-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT eei", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  await repos.updateAgent(agentId, { api_enabled: 1 }, { expectedRevision: "system" });
  appId = await repos.createApiApp({ key: `it-eei-${suffix}`, name: "IT eei", ownerOrgUnitId: ROOT, scopes: ["runs:create", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:create", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-eei-${suffix}@forge.local`, username: `it-eei-${suffix}`, displayName: "IT", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-eei-sub-${suffix}` });
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


type Case = [string, Payload];
const EMPTY: Case[] = [
  ["{}", {}],
  ["text null", { text: null }],
  ["text \"\"", { text: "" }],
  ["text blank", { text: " \n\t " }],
  ["input null", { input: null }],
  ["input {}", { input: {} }],
  ["input \"{}\" (JSON text)", { input: "{}" }],
  ["text \"\" + input {}", { text: "", input: {} }],
  ["text null + input null", { text: null, input: null }],
  ["text blank + input null", { text: "   ", input: null }],
  ["input {text:\"\"} only (negative)", { input: { text: "" } }],
  ["input {text:blank} only", { input: { text: "  " } }],
  ["input {text:null} only", { input: { text: null } }],
  ["input \"{\\\"text\\\":\\\" \\\"}\" (JSON text)", { input: '{"text":" "}' }],
];
const NON_EMPTY: Case[] = [
  ["text + input {}", { text: "hi", input: {} }],
  ["text + input null", { text: "hi", input: null }],
  ["text \"\" + input object (item-9 alignment)", { text: "", input: { foo: 1 } }],
  ["text null + input with text", { text: null, input: { text: "x" } }],
  ["input {text:\"\", file} (positive: another key)", { input: { text: "", file: "f-1" } }],
  ["text + input {text:\"\"}", { text: "hi", input: { text: "" } }],
];
const ARRAY_INPUT: Case[] = [
  ["input [] (array field)", { input: [] }],
  ["input \"[]\" (JSON text)", { input: "[]" }],
  ["text + input [1]", { text: "hi", input: [1] }],
];
const B = "----eei";
const multipart = (fields: Record<string, string>) => fields && Object.entries(fields).map(([k, v]) => `--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") + `--${B}--\r\n`;
const MP = { "content-type": `multipart/form-data; boundary=${B}` };

describe.each(entries.map((entry) => [entry.name, entry] as const))("item E: %s", (_name, entry) => {
  it.each(EMPTY)("empty input (%s) -> 400 CFG-8501, no Run, no audit", async (_label, payload) => {
    const runsBefore = await runCount();
    const auditsBefore = await auditCount();
    const res = await entry.call(payload);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(errorOf(res).message).toContain("text 或 input");
    expect(await runCount()).toBe(runsBefore);
    expect(await auditCount()).toBe(auditsBefore);
  });
  it.each(NON_EMPTY)("non-empty (%s) -> accepted, one Run", async (_label, payload) => {
    const runsBefore = await runCount();
    const res = await entry.call(payload);
    expect([200, 202], res.body).toContain(res.statusCode);
    expect(await runCount()).toBe(runsBefore + 1);
  });
  it.each(ARRAY_INPUT)("array input (%s) -> 400 CFG-8501 (input must be an object), no Run", async (_label, payload) => {
    const runsBefore = await runCount();
    const res = await entry.call(payload);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(await runCount()).toBe(runsBefore);
  });
});

describe("item E: no body and multipart", () => {
  const openUrls = () => [`/open/v1/agents/${agentKey}/runs`, `/open/v1/agents/${agentKey}/invoke?wait=0`];
  it("open: no body -> 400, no Run", async () => {
    for (const url of openUrls()) {
      const before = await runCount();
      const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${openKey}` } });
      expect(res.statusCode, `${url} ${res.body}`).toBe(400);
      expect(errorOf(res).message).toContain("text 或 input");
      expect(await runCount()).toBe(before);
    }
  });
  it("open: multipart with empty field values -> 400 (same check), no Run", async () => {
    for (const url of openUrls()) {
      const before = await runCount();
      const res = await app.inject({ method: "POST", url, headers: { ...MP, authorization: `Bearer ${openKey}` }, payload: multipart({ text: "", input: "" }) });
      expect(res.statusCode, `${url} ${res.body}`).toBe(400);
      expect(errorOf(res).message).toContain("text 或 input");
      expect(await runCount()).toBe(before);
    }
  });
  it("integration: multipart with empty field values -> 400, no Run", async () => {
    const before = await runCount();
    const res = await connectorApp.inject({ method: "POST", url: "/integration/v1/runs", headers: { ...MP, authorization: `Bearer ${await connectorToken()}` }, payload: multipart({ agentKey, text: "", input: "" }) });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(await runCount()).toBe(before);
  });
});
