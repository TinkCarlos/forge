import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { builtinTools, callMcpTool, discoverMcpTools, executeOpenApiTool } from "@forge/capabilities";
import { config, encryptSecret, OUTBOUND_BLOCKED_CODE, OUTBOUND_BLOCKED_MESSAGE, setOutboundResolver } from "@forge/core";
import { buildOidcAuthorizeUrl, sessionCookieValue } from "@forge/identity";
import { callModel } from "@forge/models";
import { deliverDueWebhooks } from "@forge/runtime";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// S-46 / S-47: every outbound entry point refuses loopback, cloud metadata and non-http schemes with 400 HTP-4003.
// Saving configuration does a static check; making the request does the full (DNS) check. DNS is mocked: names
// resolve only through the table below, so nothing here can reach the public network.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const BAD = ["http://127.0.0.1:9/x", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"];
const DNS: Record<string, string> = { "metadata.attacker.example": "169.254.169.254", "intranet.attacker.example": "10.1.2.3" };
let app: FastifyInstance;
let headers: Record<string, string> = {};
const cleanup: Array<() => Promise<unknown>> = [];

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error?: { code: string; message: string } }).error;
const expectBlocked = (res: LightMyRequestResponse) => {
  expect(res.statusCode, res.body).toBe(400);
  expect(errorOf(res)).toMatchObject({ code: OUTBOUND_BLOCKED_CODE, message: OUTBOUND_BLOCKED_MESSAGE });
  expect(res.body).not.toMatch(/169\.254|127\.0\.0\.1|10\.1\.2\.3/);
};
const tag = () => randomBytes(4).toString("hex");

beforeAll(async () => {
  setOutboundResolver(async (host) => {
    const address = DNS[host];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  });
  app = await buildApp({ logger: false });
  await app.ready();
  const admin = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(admin, sessionCookieValue(admin));
});

afterAll(async () => {
  setOutboundResolver(null);
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  await cleanupRealSessions();
  await app?.close();
});

describe("static check when saving configuration", () => {
  for (const url of BAD) {
    it(`MCP create / update refuse ${url}`, async () => {
      const key = `it-ob-mcp-${tag()}`;
      expectBlocked(await app.inject({ method: "POST", url: "/admin/api/mcp", headers, payload: { key, url } }));
      expect(await repos.getMcpServerByKey(key)).toBeNull();
      const id = await repos.createMcpServer({ key, name: key, url: "https://mcp.example/mcp", createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM mcp_servers WHERE id = ?", [id]));
      expectBlocked(await app.inject({ method: "PATCH", url: `/admin/api/mcp/${id}`, headers: await configurationHeaders(`/admin/api/mcp/${id}`, headers), payload: { url } }));
      expect((await repos.getMcpServer(id))!.url).toBe("https://mcp.example/mcp");
    });

    it(`Provider create / update refuse ${url}`, async () => {
      const key = `it-ob-prv-${tag()}`;
      expectBlocked(await app.inject({ method: "POST", url: "/admin/api/providers", headers, payload: { key, baseUrl: url } }));
      expect(await repos.getProviderByKey(key)).toBeNull();
      const id = await repos.createProvider({ key, name: key, protocol: "openai-compatible", baseUrl: "https://llm.example/v1", createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM llm_providers WHERE id = ?", [id]));
      expectBlocked(await app.inject({ method: "PATCH", url: `/admin/api/providers/${id}`, headers: await configurationHeaders(`/admin/api/providers/${id}`, headers), payload: { baseUrl: url } }));
    });

    it(`OpenAPI tool source import refuses ${url}`, async () => {
      const key = `it-ob-ts-${tag()}`;
      expectBlocked(await app.inject({ method: "POST", url: "/admin/api/tool-sources/import", headers, payload: { key, baseUrl: url, spec: { openapi: "3.0.0", paths: {} } } }));
      // servers[0].url is checked the same way
      expectBlocked(await app.inject({ method: "POST", url: "/admin/api/tool-sources/import", headers, payload: { key, spec: { openapi: "3.0.0", servers: [{ url }], paths: {} } } }));
    });

    it(`app webhook URL create / update refuse ${url}`, async () => {
      const key = `it-ob-app-${tag()}`;
      expectBlocked(await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key, webhookUrl: url, webhookSecret: "whsec_x" } }));
      const id = await repos.createApiApp({ key, name: key, ownerOrgUnitId: ROOT, scopes: ["runs:read"], createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM api_apps WHERE id = ?", [id]));
      expectBlocked(await app.inject({ method: "PATCH", url: `/admin/api/apps/${id}`, headers: await configurationHeaders(`/admin/api/apps/${id}`, headers), payload: { webhookUrl: url } }));
      expect((await repos.getApiApp(id))!.webhook_url).toBeNull();
    });
  }
});

// Rows saved before the guard existed (or names that only resolve to private addresses) are refused when used.
const LIVE_BAD = [...BAD, "http://metadata.attacker.example/", "http://intranet.attacker.example:8080/"];

describe("full check when the request is made", () => {
  for (const url of LIVE_BAD) {
    it(`MCP refresh / discover / tool call refuse ${url}`, async () => {
      const key = `it-ob-mcpl-${tag()}`;
      const id = await repos.createMcpServer({ key, name: key, url, createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM mcp_servers WHERE id = ?", [id]));
      expectBlocked(await app.inject({ method: "POST", url: `/admin/api/mcp/${id}/refresh`, headers: await configurationHeaders(`/admin/api/mcp/${id}/refresh`, headers), payload: {} }));
      const server = (await repos.getMcpServer(id))!;
      await expect(discoverMcpTools(server)).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
      const result = await callMcpTool(server, "anything", {});
      expect(result).toMatchObject({ ok: false, errorCode: OUTBOUND_BLOCKED_CODE });
      expect(result.content).not.toMatch(/169\.254|10\.1\.2\.3/);
    });

    it(`Provider test and model call refuse ${url}`, async () => {
      const key = `it-ob-prvl-${tag()}`;
      const id = await repos.createProvider({ key, name: key, protocol: "openai-compatible", baseUrl: url, createdBy: ADMIN_ID });
      await repos.createModel({ providerId: id, key: "m1", displayName: "m1" });
      cleanup.push(() => execute("DELETE FROM llm_providers WHERE id = ?", [id]));
      cleanup.push(() => execute("DELETE FROM llm_models WHERE provider_id = ?", [id]));
      expectBlocked(await app.inject({ method: "POST", url: `/admin/api/providers/${id}/test`, headers: await configurationHeaders(`/admin/api/providers/${id}/test`, headers), payload: {} }));
      await expect(callModel({ providerKey: key, modelKey: "m1", messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
    });

    it(`web_fetch and OpenAPI tools refuse ${url}`, async () => {
      const fetched = await builtinTools().get("web_fetch")!.execute({ url });
      expect(fetched).toMatchObject({ ok: false, errorCode: OUTBOUND_BLOCKED_CODE });
      expect(fetched.content).not.toMatch(/169\.254|10\.1\.2\.3/);
      const base = url.replace(/\/[^/]*$/, "");
      const tool = await executeOpenApiTool({ source: { base_url: base, headers_json: {} }, tool: { path: "/items", method: "GET" }, args: {} });
      expect(tool).toMatchObject({ ok: false, errorCode: OUTBOUND_BLOCKED_CODE });
    });

    it(`webhook delivery and replay refuse ${url}`, async () => {
      const key = `it-ob-wh-${tag()}`;
      const appId = await repos.createApiApp({ key, name: key, ownerOrgUnitId: ROOT, scopes: ["runs:read"], webhookUrl: url, webhookSecretEncrypted: encryptSecret("whsec_x", config.FORGE_MASTER_KEY), createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM api_apps WHERE id = ?", [appId]));
      cleanup.push(() => execute("DELETE FROM webhook_deliveries WHERE app_id = ?", [appId]));
      await repos.enqueueWebhook({ appId, eventId: `evt_${key}`, eventType: "run.completed", payload: { id: "x" } });
      await deliverDueWebhooks();
      const [row] = await query<{ id: string; status: string; error_message: string | null }>("SELECT id, status, error_message FROM webhook_deliveries WHERE app_id = ?", [appId]);
      expect(row!.status).toBe("failed");
      expect(row!.error_message).toContain(OUTBOUND_BLOCKED_CODE);
      expect(row!.error_message).not.toMatch(/169\.254|10\.1\.2\.3/);
      const replay = await app.inject({ method: "POST", url: `/admin/api/webhook-deliveries/${row!.id}/replay`, headers, payload: {} });
      expect(replay.statusCode).toBe(200);
      expect((replay.json() as { status: string }).status).toBe("failed");
    });

    it(`OIDC discovery refuses issuer ${url}`, async () => {
      const original = { OIDC_ISSUER:config.OIDC_ISSUER,OIDC_CLIENT_ID:config.OIDC_CLIENT_ID,OIDC_CLIENT_SECRET:config.OIDC_CLIENT_SECRET,SSO_MODE:config.SSO_MODE };
      Object.assign(config,{OIDC_ISSUER:url,OIDC_CLIENT_ID:"mock",OIDC_CLIENT_SECRET:"synthetic",SSO_MODE:"optional"});
      try {
        await expect(buildOidcAuthorizeUrl("/")).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
      } finally {
        Object.assign(config,original);
      }
    });
  }
});
