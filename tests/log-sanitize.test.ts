import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
// Pure module (only a type import from fastify): no config, .env or database.
import { installSanitizedNotFoundHandler, REDACTED, requestLogSerializers, sanitizeUrlForLog, serializeRequestForLog, SENSITIVE_QUERY_KEYS } from "../apps/api/src/plugins/log-sanitize";

const R = REDACTED;

describe("K-26: sanitizeUrlForLog", () => {
  it("redacts every listed key and keeps path + other params", () => {
    for (const key of SENSITIVE_QUERY_KEYS) {
      expect(sanitizeUrlForLog(`/p?a=1&${key}=s3cr3t&b=2`)).toBe(`/p?a=1&${key}=${R}&b=2`);
    }
    expect(SENSITIVE_QUERY_KEYS.size).toBe(14); // 12 from K-26 + error_description / error_uri (P2-06)
  });
  it("is case-insensitive", () => {
    expect(sanitizeUrlForLog("/cb?Code=abc&STATE=xyz&Access_Token=t")).toBe(`/cb?Code=${R}&STATE=${R}&Access_Token=${R}`);
  });
  it("redacts repeated keys", () => {
    expect(sanitizeUrlForLog("/x?token=a&token=b&q=1&token=")).toBe(`/x?token=${R}&token=${R}&q=1&token=${R}`);
  });
  it("matches percent-encoded / double-encoded / plus-encoded / bracket keys", () => {
    expect(sanitizeUrlForLog("/x?%74oken=a")).toBe(`/x?%74oken=${R}`);
    expect(sanitizeUrlForLog("/x?%2574oken=a")).toBe(`/x?%2574oken=${R}`);
    expect(sanitizeUrlForLog("/x?api%5Fkey=a")).toBe(`/x?api%5Fkey=${R}`);
    expect(sanitizeUrlForLog("/x?password%5B%5D=a&password[]=b")).toBe(`/x?password%5B%5D=${R}&password[]=${R}`);
    expect(sanitizeUrlForLog("/x?%20key%20=a")).toBe(`/x?%20key%20=${R}`);
  });
  it("redacts the whole value including '=' and encoded characters", () => {
    expect(sanitizeUrlForLog("/x?token=a=b%3Dc&n=1")).toBe(`/x?token=${R}&n=1`);
  });
  it("does not redact similar but unlisted keys or values that look sensitive", () => {
    expect(sanitizeUrlForLog("/x?tokens=1&keyword=2&postcode=3&q=token")).toBe("/x?tokens=1&keyword=2&postcode=3&q=token");
  });
  it("handles malformed input without throwing", () => {
    expect(sanitizeUrlForLog("/x?%E0%A4%A=1&token=%ZZ")).toBe(`/x?%E0%A4%A=1&token=${R}`);
    expect(sanitizeUrlForLog("/x?%E0%A4%A=1&tok%en=1")).toBe("/x?%E0%A4%A=1&tok%en=1");
    expect(sanitizeUrlForLog("/x?")).toBe("/x?");
    expect(sanitizeUrlForLog("/x?&&token")).toBe(`/x?&&token=${R}`);
    expect(sanitizeUrlForLog("?token=1")).toBe(`?token=${R}`);
    expect(sanitizeUrlForLog("http://h/x?token=1")).toBe(`http://h/x?token=${R}`);
    expect(sanitizeUrlForLog(undefined)).toBe("");
    expect(sanitizeUrlForLog(42)).toBe("");
  });
  it("drops the fragment and caps the length", () => {
    expect(sanitizeUrlForLog("/x?a=1#access_token=abc")).toBe("/x?a=1");
    const long = sanitizeUrlForLog(`/x?q=${"a".repeat(5000)}&token=zzz`);
    expect(long.length).toBeLessThan(2100);
    expect(long).not.toContain("zzz");
  });
  it("leaves URLs without a query unchanged", () => {
    expect(sanitizeUrlForLog("/admin/api/agents/agt_1")).toBe("/admin/api/agents/agt_1");
  });
});

describe("K-26: serializeRequestForLog", () => {
  it("keeps Fastify's default req fields and sanitizes url", () => {
    const out = serializeRequestForLog({ method: "GET", url: "/auth/oidc/callback?code=abc&state=def", headers: { "accept-version": "1" }, host: "h", ip: "127.0.0.1", socket: { remotePort: 5 } });
    expect(out).toEqual({ method: "GET", url: `/auth/oidc/callback?code=${R}&state=${R}`, version: "1", host: "h", remoteAddress: "127.0.0.1", remotePort: 5 });
  });
});

describe("K-26: end to end through a Fastify logger (app.inject, no network, no DB)", () => {
  async function withApp() {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const app = Fastify({ logger: { level: "info", stream, serializers: requestLogSerializers } });
    installSanitizedNotFoundHandler(app);
    app.get("/ok", async () => ({ ok: true }));
    await app.ready();
    return { app, lines };
  }
  it("incoming-request log and 404 log/response contain no secret query values", async () => {
    const { app, lines } = await withApp();
    const ok = await app.inject({ method: "GET", url: "/ok?token=SECRET1&API_KEY=SECRET2&x=1" });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: "GET", url: "/nope?client_secret=SECRET3&code=SECRET4" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "RUN-7001", message: "资源不存在", requestId: expect.any(String), details: null, retryable: false } }); // P3-01: unified body, nothing of the URL
    await app.close();
    const all = lines.join("");
    expect(all).not.toMatch(/SECRET[1-4]/);
    expect(all).toContain(`/ok?token=${R}&API_KEY=${R}&x=1`);
    expect(all).toContain(`Route GET:/nope?client_secret=${R}&code=${R} not found`);
  });
});

describe("P2-06: OIDC error_description / error_uri are redacted", () => {
  it("redacts both, any case, repeated keys, long values", () => {
    const out = sanitizeUrlForLog(`/auth/oidc/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&Error_Description=${"A".repeat(500)}&error_uri=https%3A%2F%2Fevil.example%2Fx`);
    expect(out).toContain("error=access_denied");
    expect(out).not.toContain("%3Cscript"); // the key name error_description itself contains "script"
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("AAAA");
    expect(out).not.toContain("evil.example");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});
