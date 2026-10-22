import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { builtinTools, callMcpTool } from "@forge/capabilities";
import {
  assertOutboundAllowed,
  config,
  encryptSecret,
  OUTBOUND_BLOCKED_CODE,
  parseOutboundAllowlist,
  safeFetch,
  setOutboundLogger,
  setOutboundResolver,
  type OutboundBlockLog,
} from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { deliverDueWebhooks } from "@forge/runtime";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// AD (G follow-up, S-46~S-49): server log records host, resolved IPs and a reason; responses never echo the IP;
// webhook deliveries store error_code; OIDC browser entry points redirect to /next/sign-in?ssoError=HTP-4003;
// OUTBOUND_ALLOWLIST is exact host:port only.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const IP_RE = /169\.254\.169\.254|127\.0\.0\.1|10\.1\.2\.3|10\.9\.9\.9|::1|fd00::/;
const DNS: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
  "intranet.attacker.example": [{ address: "10.1.2.3", family: 4 }],
  "meta.attacker.example": [{ address: "169.254.169.254", family: 4 }],
  "ula.attacker.example": [{ address: "fd00::1", family: 6 }],
};
let logs: OutboundBlockLog[] = [];
let app: FastifyInstance;
let headers: Record<string, string> = {};
let server: Server;
let port = 0;
const cleanup: Array<() => Promise<unknown>> = [];
const savedConfig = { ...config } as Record<string, unknown>;
const cfg = config as unknown as Record<string, unknown>;

beforeAll(async () => {
  setOutboundResolver(async (host) => {
    const answer = DNS[host];
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answer;
  });
  setOutboundLogger((entry) => logs.push(entry));
  // Local stand-in for redirects and an OIDC issuer (allowlisted per test by its exact port).
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const base = `http://127.0.0.1:${port}`;
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end();
      return;
    }
    // Issuer A: token endpoint blocked. Issuer B: token ok, JWKS blocked.
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      const which = url.pathname.startsWith("/a") ? "a" : "b";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        issuer: `${base}/${which}`,
        authorization_endpoint: `${base}/${which}/authorize`,
        token_endpoint: which === "a" ? "http://169.254.169.254/token" : `${base}/b/token`,
        jwks_uri: which === "a" ? `${base}/a/jwks` : "http://intranet.attacker.example/jwks",
      }));
      return;
    }
    if (url.pathname === "/b/token") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: "x.y.z" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
});

beforeEach(() => {
  logs = [];
  for (const key of ["OUTBOUND_ALLOWLIST", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]) cfg[key] = savedConfig[key];
});

afterAll(async () => {
  for (const key of ["OUTBOUND_ALLOWLIST", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]) cfg[key] = savedConfig[key];
  setOutboundResolver(null);
  setOutboundLogger(null);
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  await cleanupRealSessions();
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
});

const reasonOf = async (url: string, allowlist: string[] = []) => {
  logs = [];
  await expect(assertOutboundAllowed(url, { allowlist })).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
  expect(logs).toHaveLength(1);
  return logs[0]!;
};

describe("server log: host, resolved IPs, reason (AD)", () => {
  const cases: Array<[string, string, string, string[]]> = [
    ["http://127.0.0.1:9/x", "127.0.0.1", "loopback", ["127.0.0.1"]],
    ["http://[::1]/", "::1", "loopback", ["::1"]],
    ["http://10.0.0.5/", "10.0.0.5", "private", ["10.0.0.5"]],
    ["http://[fd00::1]/", "fd00::1", "private", ["fd00::1"]],
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254", "metadata", ["169.254.169.254"]],
    ["http://169.254.1.1/", "169.254.1.1", "link_local", ["169.254.1.1"]],
    ["http://100.64.0.1/", "100.64.0.1", "cgnat", ["100.64.0.1"]],
    ["http://0.0.0.0/", "0.0.0.0", "unspecified", ["0.0.0.0"]],
    // IPv4-mapped IPv6 is classified by the embedded IPv4 when that is itself reserved; otherwise "ipv4_mapped".
    ["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1", "loopback", ["::ffff:7f00:1"]],
    ["http://[::ffff:8.8.8.8]/", "::ffff:808:808", "ipv4_mapped", ["::ffff:808:808"]],
    ["http://2852039166/", "169.254.169.254", "metadata", ["169.254.169.254"]],
    ["http://0177.0.0.1/", "127.0.0.1", "loopback", ["127.0.0.1"]],
    ["http://intranet.attacker.example/", "intranet.attacker.example", "private", ["10.1.2.3"]],
    ["http://meta.attacker.example/", "meta.attacker.example", "metadata", ["169.254.169.254"]],
    ["http://ula.attacker.example/", "ula.attacker.example", "private", ["fd00::1"]],
    ["http://localhost:3000/", "localhost", "local_hostname", []],
  ];
  for (const [url, host, reason, addresses] of cases) {
    it(`${url} -> reason ${reason}`, async () => {
      const entry = await reasonOf(url);
      expect(entry).toMatchObject({ event: "outbound.blocked", code: OUTBOUND_BLOCKED_CODE, host, reason, addresses });
    });
  }
  it("file:// -> reason scheme", async () => {
    expect(await reasonOf("file:///etc/passwd")).toMatchObject({ reason: "scheme", protocol: "file:" });
  });
  it("302 from an allowlisted host to 169.254.169.254 -> reason redirect (targetReason metadata, hop 1)", async () => {
    const allow = parseOutboundAllowlist(`127.0.0.1:${port}`);
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent("http://169.254.169.254/")}`, { allowlist: allow })).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
    expect(logs.at(-1)).toMatchObject({ reason: "redirect", targetReason: "metadata", hop: 1, host: "169.254.169.254", addresses: ["169.254.169.254"] });
  });
  it("the log never carries the URL path / query (may hold secrets)", async () => {
    const entry = await reasonOf("http://10.0.0.5/cb?token=s3cr3t");
    expect(JSON.stringify(entry)).not.toContain("s3cr3t");
  });
});

describe("OUTBOUND_ALLOWLIST is exact host:port (AD)", () => {
  it("127.0.0.1:8090 allowed, 127.0.0.1:8091 HTP-4003 (no socket opened)", async () => {
    const list = parseOutboundAllowlist("127.0.0.1:8090");
    await expect(assertOutboundAllowed("http://127.0.0.1:8090/mcp", { allowlist: list })).resolves.toMatchObject({ allowlisted: true });
    await expect(assertOutboundAllowed("http://127.0.0.1:8091/mcp", { allowlist: list })).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
    await expect(assertOutboundAllowed("http://localhost:8090/mcp", { allowlist: list })).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
  });
  it("config.OUTBOUND_ALLOWLIST=127.0.0.1:8090 is honoured the same way", async () => {
    cfg.OUTBOUND_ALLOWLIST = "127.0.0.1:8090";
    await expect(assertOutboundAllowed("http://127.0.0.1:8090/")).resolves.toMatchObject({ allowlisted: true });
    await expect(assertOutboundAllowed("http://127.0.0.1:8091/")).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
  });
  it("an allowlisted host that 302-redirects to 169.254.169.254 is still blocked", async () => {
    cfg.OUTBOUND_ALLOWLIST = `127.0.0.1:${port}`;
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`)).rejects.toMatchObject({ code: OUTBOUND_BLOCKED_CODE });
  });
  for (const bad of ["127.0.0.1", "*.example:443", "10.0.0.0/8", "10.0.0.0/8:80", "host:", ":80", "127.0.0.1:8090:1"]) {
    it(`invalid entry "${bad}" is rejected`, () => expect(() => parseOutboundAllowlist(bad)).toThrow());
  }
});

describe("webhook delivery stores error_code (AD)", () => {
  it("blocked target -> failed, error_code HTP-4003, no IP in the admin list or replay response", async () => {
    const key = `it-ad-wh-${suffix}`;
    const appId = await repos.createApiApp({ key, name: key, ownerOrgUnitId: ROOT, scopes: ["runs:read"], webhookUrl: "http://intranet.attacker.example/hook", webhookSecretEncrypted: encryptSecret("whsec_x", config.FORGE_MASTER_KEY), createdBy: ADMIN_ID });
    cleanup.push(() => execute("DELETE FROM api_apps WHERE id = ?", [appId]));
    await repos.enqueueWebhook({ appId, eventId: `evt_${key}`, eventType: "run.completed", payload: { id: "x" } });
    await deliverDueWebhooks();
    const [row] = await query<{ id: string; status: string; error_code: string | null; error_message: string | null }>("SELECT id, status, error_code, error_message FROM webhook_deliveries WHERE app_id = ?", [appId]);
    expect(row).toMatchObject({ status: "failed", error_code: OUTBOUND_BLOCKED_CODE });
    expect(row!.error_message ?? "").not.toMatch(IP_RE);
    expect(logs.some((l) => l.reason === "private" && l.addresses.includes("10.1.2.3"))).toBe(true);
    const list = await app.inject({ method: "GET", url: `/admin/api/apps/${appId}/webhook-deliveries`, headers });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Array<{ errorCode: string }> }).items[0]!.errorCode).toBe(OUTBOUND_BLOCKED_CODE);
    expect(list.body).not.toMatch(IP_RE);
    const replay = await app.inject({ method: "POST", url: `/admin/api/webhook-deliveries/${row!.id}/replay`, headers, payload: {} });
    expect(replay.body).not.toMatch(IP_RE);
  });
});

describe("responses never echo the resolved IP (AD)", () => {
  const expectClean = (res: LightMyRequestResponse) => {
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(OUTBOUND_BLOCKED_CODE);
    expect(res.body).not.toMatch(IP_RE);
  };
  for (const url of ["http://intranet.attacker.example/", "http://meta.attacker.example/", "http://ula.attacker.example/", "http://169.254.169.254/"]) {
    it(`MCP refresh, provider test, MCP tool call, web_fetch: ${url}`, async () => {
      const k = `it-ad-${randomBytes(3).toString("hex")}`;
      const mcpId = await repos.createMcpServer({ key: `${k}-mcp`, name: k, url, createdBy: ADMIN_ID });
      cleanup.push(() => execute("DELETE FROM mcp_servers WHERE id = ?", [mcpId]));
      expectClean(await app.inject({ method: "POST", url: `/admin/api/mcp/${mcpId}/refresh`, headers, payload: {} }));
      const providerId = await repos.createProvider({ key: `${k}-prv`, name: k, protocol: "openai-compatible", baseUrl: url, createdBy: ADMIN_ID });
      await repos.createModel({ providerId, key: "m1", displayName: "m1" });
      cleanup.push(() => execute("DELETE FROM llm_providers WHERE id = ?", [providerId]));
      cleanup.push(() => execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]));
      expectClean(await app.inject({ method: "POST", url: `/admin/api/providers/${providerId}/test`, headers, payload: {} }));
      const tool = await callMcpTool((await repos.getMcpServer(mcpId))!, "x", {});
      expect(JSON.stringify(tool)).not.toMatch(IP_RE);
      const fetched = await builtinTools().get("web_fetch")!.execute({ url });
      expect(fetched).toMatchObject({ ok: false, errorCode: OUTBOUND_BLOCKED_CODE });
      expect(JSON.stringify(fetched)).not.toMatch(IP_RE);
    });
  }
});

describe("OIDC browser entry points redirect to /next/sign-in?ssoError=HTP-4003 (AD)", () => {
  const configure = (issuer: string) => {
    cfg.OIDC_ISSUER = issuer;
    cfg.OIDC_CLIENT_ID = "forge-test";
    cfg.OIDC_CLIENT_SECRET = "secret";
  };
  const expectSsoRedirect = (res: LightMyRequestResponse, returnTo?: string) => {
    expect(res.statusCode, res.body).toBe(302);
    const location = new URL(String(res.headers.location), "http://forge.local");
    expect(location.pathname).toBe("/next/sign-in");
    expect(location.searchParams.get("ssoError")).toBe(OUTBOUND_BLOCKED_CODE);
    expect(location.searchParams.get("returnTo")).toBe(returnTo ?? null);
    expect(String(res.headers.location)).not.toMatch(IP_RE);
    expect(res.body).not.toMatch(IP_RE);
  };

  it("discovery blocked: login -> 302 sign-in with ssoError, valid returnTo kept; log reason metadata", async () => {
    configure("http://169.254.169.254/oidc");
    expectSsoRedirect(await app.inject({ method: "GET", url: "/auth/oidc/login?returnTo=%2Fnext%2Fagents" }), "/next/agents");
    expect(logs.at(-1)).toMatchObject({ reason: "metadata" });
  });

  it("discovery blocked: unsafe returnTo is dropped (S-30)", async () => {
    configure("http://intranet.attacker.example/oidc");
    expectSsoRedirect(await app.inject({ method: "GET", url: "/auth/oidc/login?returnTo=%2F%2Fevil.example" }));
    expectSsoRedirect(await app.inject({ method: "GET", url: "/auth/oidc/login" }));
  });

  it("token endpoint blocked: callback -> 302 sign-in with ssoError and the saved returnTo", async () => {
    cfg.OUTBOUND_ALLOWLIST = `127.0.0.1:${port}`;
    configure(`http://127.0.0.1:${port}/a`);
    const login = await app.inject({ method: "GET", url: "/auth/oidc/login?returnTo=%2Fnext%2Fruns" });
    expect(login.statusCode, login.body).toBe(302);
    const state = new URL(String(login.headers.location)).searchParams.get("state")!;
    expectSsoRedirect(await app.inject({ method: "GET", url: `/auth/oidc/callback?code=c&state=${state}` }), "/next/runs");
    expect(logs.at(-1)).toMatchObject({ reason: "metadata", host: "169.254.169.254" });
  });

  it("JWKS blocked: callback -> 302 sign-in with ssoError", async () => {
    cfg.OUTBOUND_ALLOWLIST = `127.0.0.1:${port}`;
    configure(`http://127.0.0.1:${port}/b`);
    const login = await app.inject({ method: "GET", url: "/auth/oidc/login" });
    const state = new URL(String(login.headers.location)).searchParams.get("state")!;
    expectSsoRedirect(await app.inject({ method: "GET", url: `/auth/oidc/callback?code=c&state=${state}` }));
    expect(logs.at(-1)).toMatchObject({ reason: "private", addresses: ["10.1.2.3"] });
  });
});
