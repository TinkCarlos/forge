import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// SSO-1212 hardening (architect ruling 2): when the IdP answers the callback with error= / error_description=, the
// 302 carries only our own code (ssoError=SSO-1212); the IdP's raw error and error_description appear neither in the
// URL nor in any response (302 or the JSON error of an API client). Before reaching the logs the raw values are
// sanitized: error_description is never logged; error is logged only when it is a plain OAuth error token
// ([A-Za-z0-9_.-], at most 64 chars), anything else is [REDACTED] (request URL line and the dedicated warn line).
const identity = vi.hoisted(() => ({ handleOidcCallback: vi.fn(), pendingOidcReturnTo: vi.fn() }));
vi.mock("@forge/identity", async (importOriginal) => ({ ...(await importOriginal<object>()), ...identity }));

const { buildApp } = await import("../apps/api/src/app.js");
const { sanitizeIdpError, sanitizeUrlForLog } = await import("../apps/api/src/plugins/log-sanitize.js");

const HTML = { accept: "text/html" };
const JSON_ONLY = { accept: "application/json" };
const RAW_ERROR = "evil_err<script>alert(1)</script>\r\nINJECTED-LINE";
const RAW_DESC = "IdP-detail <img src=x onerror=alert(2)> user alice@example.com";
const MARKERS = [/evil_err/, /<script/i, /%3Cscript/i, /<img/i, /\\r\\n|\r\n/, /alert\(/, /INJECTED-LINE/, /IdP-detail/, /onerror/, /alice@example\.com/, /alice%40example/];

const lines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  app = await buildApp({ logger: { level: "info", stream } });
  await app.ready();
});
afterAll(async () => app?.close());
beforeEach(() => {
  lines.length = 0;
  identity.handleOidcCallback.mockReset();
  identity.pendingOidcReturnTo.mockReset().mockReturnValue("/next/runs");
});

const qs = (error: string, desc: string) => `error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(desc)}&error_uri=${encodeURIComponent("https://idp.example/err?d=IdP-detail")}&state=s1`;
const callback = (query: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/auth/oidc/callback?${query}`, headers });
const decodedEverything = (text: string) => { try { return `${text}\n${decodeURIComponent(text)}`; } catch { return text; } };

describe("SSO-1212: the IdP's raw error / error_description never leave in the URL or a response", () => {
  it("browser: 302 Location is exactly /next/sign-in?ssoError=SSO-1212&redirect=..., body has no raw value", async () => {
    const res = await callback(qs(RAW_ERROR, RAW_DESC), HTML);
    expect(res.statusCode).toBe(302);
    const loc = String(res.headers.location);
    const url = new URL(loc, "http://x");
    expect(url.pathname).toBe("/next/sign-in");
    expect([...url.searchParams.keys()].sort()).toEqual(["redirect", "ssoError"]);
    expect(url.searchParams.get("ssoError")).toBe("SSO-1212");
    const { "content-security-policy": _csp, ...headers } = res.headers; // CSP is fixed text, not request data
    for (const marker of MARKERS) {
      expect(decodedEverything(loc)).not.toMatch(marker);
      expect(res.body).not.toMatch(marker);
      expect(decodedEverything(JSON.stringify(headers))).not.toMatch(marker);
    }
  });

  it("API client: 401 SSO-1212 with our fixed message only", async () => {
    const res = await callback(qs(RAW_ERROR, RAW_DESC), JSON_ONLY);
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string; details: unknown } };
    expect(body.error).toMatchObject({ code: "SSO-1212", message: "身份提供方拒绝了登录", details: null });
    for (const marker of MARKERS) expect(res.body).not.toMatch(marker);
  });
});

describe("SSO-1212: raw values are sanitized before they reach the logs", () => {
  it("a hostile error / error_description: no raw text in any log line; the warn line says [REDACTED]", async () => {
    await callback(qs(RAW_ERROR, RAW_DESC), HTML);
    const all = lines.join("");
    for (const marker of MARKERS) expect(decodedEverything(all)).not.toMatch(marker);
    const warn = lines.map((l) => JSON.parse(l) as { msg?: string; idpError?: string }).find((e) => e.msg === "oidc callback: identity provider returned an error");
    expect(warn?.idpError).toBe("[REDACTED]");
  });

  it("a plain OAuth error token (access_denied) is kept, error_description still dropped", async () => {
    await callback(qs("access_denied", RAW_DESC), HTML);
    const entries = lines.map((l) => JSON.parse(l) as { msg?: string; idpError?: string; req?: { url?: string } });
    expect(entries.find((e) => e.msg === "oidc callback: identity provider returned an error")?.idpError).toBe("access_denied");
    expect(entries.find((e) => e.req?.url)?.req?.url).toContain("error=access_denied&error_description=[REDACTED]");
    for (const marker of MARKERS) expect(decodedEverything(lines.join(""))).not.toMatch(marker);
  });

  it("sanitizeIdpError / sanitizeUrlForLog", () => {
    expect(sanitizeIdpError("access_denied")).toBe("access_denied");
    expect(sanitizeIdpError("temporarily_unavailable")).toBe("temporarily_unavailable");
    for (const bad of [RAW_ERROR, "a b", "x".repeat(65), "", ["access_denied"], 1, undefined, "access_denied\n"]) expect(sanitizeIdpError(bad)).toBe("[REDACTED]");
    expect(sanitizeUrlForLog(`/auth/oidc/callback?error=${encodeURIComponent(RAW_ERROR)}&x=1`)).toBe("/auth/oidc/callback?error=[REDACTED]&x=1");
    expect(sanitizeUrlForLog("/auth/oidc/callback?ERROR=access_denied")).toBe("/auth/oidc/callback?ERROR=access_denied");
    expect(sanitizeUrlForLog("/auth/oidc/callback?error=a%20b&error=ok")).toBe("/auth/oidc/callback?error=[REDACTED]&error=ok");
  });
});

it.each([HTML, JSON_ONLY])("records each IdP rejection once at its final boundary (%s)", async (headers) => {
  const response = await callback(qs("access_denied", RAW_DESC), headers);
  const errors = lines.map(line => JSON.parse(line) as { level: number; reqId?: string }).filter(entry => entry.level >= 40);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.reqId).toBe(response.headers["x-request-id"]);
});
