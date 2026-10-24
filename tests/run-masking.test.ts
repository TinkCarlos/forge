import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// Responses that echo tool arguments / user input, and audit details that record request payloads,
// must never carry plaintext passwords, tokens or Bearer credentials (maskArgsDeep). Stored rows keep the raw values.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRET = `s3cr3t${suffix}`;
const issuer = "forge-mask-test";
const audience = "forge-mask";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let session: Session;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let appId = "";
let openKey = "";
let runId = "";
let connectorUserId = "";
let mcpId = "";
let scheduleId = "";
const roleCode = `it-mask-${suffix}`;

const RUN_INPUT = { text: "please call", password: SECRET, nested: { auth: `Bearer ${SECRET}` } };
const TOOL_ARGS = { url: `https://x.test/cb?id=1&token=${SECRET}`, api_key: SECRET, headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ pwd: SECRET, to: "a@b.com" }) };

function assertNoPlaintext(payload: unknown): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(SECRET);
  expect(text.toLowerCase()).not.toContain("bearer ");
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  connectorApp = await buildApp({
    logger: false,
    config: {
      AGENT_CONNECTOR_ENABLED: true,
      AGENT_CONNECTOR_INBOUND_ENABLED: true,
      AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: false,
      AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(pair.publicKey)).toString("base64"),
      AGENT_CONNECTOR_ENVIRONMENT: "test",
      CONNECTOR_PRINCIPAL_ISSUER: issuer,
      CONNECTOR_PRINCIPAL_AUDIENCE: audience,
    },
  });
  await connectorApp.ready();
  session = createSession({ type: "user", id: ADMIN_ID, name: "IT Platform", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };

  agentId = await repos.createAgent({ key: `it-mask-agent-${suffix}`, name: "IT mask agent", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  appId = await repos.createApiApp({ key: `it-mask-${suffix}`, name: "IT mask", scopes: ["runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it-mask", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:read"] });
  connectorUserId = await repos.createUser({ email: `it-mask-${suffix}@forge.local`, username: `it-mask-${suffix}`, displayName: "IT mask", role: "auditor", dataScope: "all", orgUnitId: ROOT, idpSubject: `it-mask-sub-${suffix}` });

  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, appId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: RUN_INPUT, status: "succeeded" });
  const toolCallId = await repos.addToolCall({ runId, toolKey: "http.call", args: TOOL_ARGS, risk: "high", status: "succeeded" });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: RUN_INPUT });
  await repos.addMessage({ threadId, runId, seq: 2, role: "assistant", content: { text: "calling", tool_calls: [{ id: toolCallId, type: "function", function: { name: "http.call", arguments: JSON.stringify(TOOL_ARGS) } }] } });

  mcpId = await repos.createMcpServer({ key: `it-mask-mcp-${suffix}`, name: "IT mask MCP", url: "http://127.0.0.1:1/mcp", headers: {}, createdBy: ADMIN_ID });
  scheduleId = await repos.createSchedule({ key: `it-mask-sch-${suffix}`, name: "IT mask", agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", createdBy: ADMIN_ID });
});

afterAll(async () => {
  if (session) destroySession(session.token);
  await execute("DELETE FROM audit_logs WHERE actor_id = ? AND resource_id IN (?, ?)", [ADMIN_ID, mcpId, scheduleId]);
  await execute("DELETE FROM audit_logs WHERE action = 'role_mapping.upsert' AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentRoleCode')) = ?", [roleCode]);
  await execute("DELETE FROM oidc_role_mappings WHERE agent_role_code = ?", [roleCode]);
  if (scheduleId) await execute("DELETE FROM schedules WHERE id = ?", [scheduleId]);
  if (mcpId) await execute("DELETE FROM mcp_servers WHERE id = ?", [mcpId]);
  if (agentId) {
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  }
  if (versionId) await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  if (agentId) await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  if (appId) {
    await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
  if (connectorUserId) await execute("DELETE FROM users WHERE id = ?", [connectorUserId]);
  await app?.close();
  await connectorApp?.close();
});

describe("run responses mask tool args and user input", () => {
  it("GET /admin/api/runs/:id: toolCalls args/args_json, input and message contents masked, structure kept", async () => {
    const res = await app.inject({ method: "GET", url: `/admin/api/runs/${runId}`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      input: Record<string, unknown>;
      toolCalls: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: Record<string, unknown> }>;
    };
    assertNoPlaintext(body);
    expect(body.input).toEqual({ text: "please call", password: "***", nested: { auth: "***" } });
    const expectedArgs = { url: "https://x.test/cb?id=1&token=***", api_key: "***", headers: { Authorization: "***" }, body: JSON.stringify({ pwd: "***", to: "a@b.com" }) };
    expect(body.toolCalls[0]!.args).toEqual(expectedArgs);
    expect(body.toolCalls[0]!.args_json).toEqual(expectedArgs);
    expect(body.messages.find((m) => m.role === "user")!.content).toEqual(body.input);
    const assistant = body.messages.find((m) => m.role === "assistant")!.content as { text: string; tool_calls: Array<{ function: { name: string; arguments: string } }> };
    expect(assistant.text).toBe("calling");
    expect(assistant.tool_calls[0]!.function.name).toBe("http.call");
    expect(JSON.parse(assistant.tool_calls[0]!.function.arguments)).toEqual(expectedArgs);
  });

  it("GET /admin/api/runs list items mask input", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/runs?limit=200", headers });
    const item = (res.json() as { items: Array<{ id: string; input: unknown }> }).items.find((run) => run.id === runId)!;
    expect(item.input).toEqual({ text: "please call", password: "***", nested: { auth: "***" } });
    assertNoPlaintext(item);
  });

  it("GET /open/v1/runs/:id masks input", async () => {
    const res = await app.inject({ method: "GET", url: `/open/v1/runs/${runId}`, headers: { authorization: `Bearer ${openKey}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { input: unknown }).input).toEqual({ text: "please call", password: "***", nested: { auth: "***" } });
    assertNoPlaintext(res.json());
  });

  it("GET /integration/v1/runs/:id masks input", async () => {
    const token = await new SignJWT({ principalType: "user", application: "mask-test", environment: "test", roles: [], subject: `it-mask-sub-${suffix}` })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const res = await connectorApp.inject({ method: "GET", url: `/integration/v1/runs/${runId}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { input: unknown }).input).toEqual({ text: "please call", password: "***", nested: { auth: "***" } });
    assertNoPlaintext(res.json());
  });

  it("stored rows keep the raw values", async () => {
    const run = await one<{ input_json: unknown }>("SELECT input_json FROM runs WHERE id = ?", [runId]);
    expect(JSON.stringify(run!.input_json)).toContain(SECRET);
    const call = await one<{ args_json: unknown }>("SELECT args_json FROM tool_calls WHERE run_id = ?", [runId]);
    expect(JSON.stringify(call!.args_json)).toContain(SECRET);
  });
});

describe("audit details are masked before they are written", () => {
  const latestAudit = async (action: string, resourceId: string | null) =>
    (await query<{ details_json: unknown }>(
      resourceId
        ? "SELECT details_json FROM audit_logs WHERE action = ? AND resource_id = ? ORDER BY created_at DESC LIMIT 1"
        : "SELECT details_json FROM audit_logs WHERE action = ? AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentRoleCode')) = ? ORDER BY created_at DESC LIMIT 1",
      [action, resourceId ?? roleCode],
    ))[0]?.details_json;

  it("mcp.update: headers_json masked in audit, raw in mcp_servers", async () => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/mcp/${mcpId}`, headers, payload: { headers: { Authorization: `Bearer ${SECRET}`, "X-Api-Key": SECRET, Accept: "application/json" } } });
    expect(res.statusCode).toBe(200);
    const details = (await latestAudit("mcp.update", mcpId)) as { headers_json: Record<string, unknown> };
    assertNoPlaintext(details);
    expect(details.headers_json).toEqual({ Authorization: "***", "X-Api-Key": "***", Accept: "application/json" });
    const stored = await one<{ headers_json: unknown }>("SELECT headers_json FROM mcp_servers WHERE id = ?", [mcpId]);
    expect(JSON.stringify(stored!.headers_json)).toContain(SECRET);
  });

  it("schedule.update: input_json masked in audit, raw in schedules", async () => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${scheduleId}`, headers, payload: { input: { text: "daily", password: SECRET, auth: `Bearer ${SECRET}` } } });
    expect(res.statusCode).toBe(200);
    const details = (await latestAudit("schedule.update", scheduleId)) as { input_json: Record<string, unknown> };
    assertNoPlaintext(details);
    expect(details.input_json).toEqual({ text: "daily", password: "***", auth: "***" });
    const stored = await one<{ input_json: unknown }>("SELECT input_json FROM schedules WHERE id = ?", [scheduleId]);
    expect(JSON.stringify(stored!.input_json)).toContain(SECRET);
  });

  it("role_mapping.upsert: only declared fields in audit, no plaintext", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/role-mappings", headers, payload: { agentRoleCode: roleCode, agentRoleName: "IT mask", localRole: "user", clientSecret: SECRET, note: `Bearer ${SECRET}` } });
    expect(res.statusCode).toBe(200);
    const details = (await latestAudit("role_mapping.upsert", null)) as Record<string, unknown>;
    assertNoPlaintext(details);
    // Only the declared fields are recorded (undeclared body fields such as clientSecret / note are neither read nor
    // written to the audit row); still masked, no plaintext anywhere.
    expect(details).toEqual({ agentRoleCode: roleCode, agentRoleName: "IT mask", localRole: "user" });
  });
});
