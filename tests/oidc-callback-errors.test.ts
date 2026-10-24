import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ForgeError, OUTBOUND_BLOCKED_CODE } from "@forge/core";

// P3-04: every error branch of the OIDC callback sends the browser back to /next/sign-in?ssoError=<whitelisted code>
// (302, plus the S-30-checked return target as `redirect`), never a JSON page. The Location carries only the code:
// no error / error_description / exception text. Only an API client (Accept: application/json without text/html)
// still gets the JSON error. The HTP-4003 branch is unchanged (always 302).
const identity = vi.hoisted(() => ({ handleOidcCallback: vi.fn(), pendingOidcReturnTo: vi.fn() }));
vi.mock("@forge/identity", async (importOriginal) => ({ ...(await importOriginal<object>()), ...identity }));

const { buildApp } = await import("../apps/api/src/app.js");
const { SSO_ERROR_CODES } = await import("../apps/api/src/routes/auth.js");

const HTML = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const JSON_ONLY = { accept: "application/json" };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => app?.close());
beforeEach(() => {
  identity.handleOidcCallback.mockReset();
  identity.pendingOidcReturnTo.mockReset().mockReturnValue("/next/runs?page=2");
});

function location(res: { statusCode: number; headers: Record<string, unknown> }): URL {
  expect(res.statusCode).toBe(302);
  const loc = String(res.headers.location);
  expect(loc.startsWith("/next/sign-in?")).toBe(true);
  return new URL(loc, "http://x");
}
const callback = (qs: string, headers: Record<string, string> = HTML) => app.inject({ method: "GET", url: `/auth/oidc/callback?${qs}`, headers });

describe("P3-04 OIDC callback error branches -> 302 sign-in", () => {
  it("IdP error=access_denied -> SSO-1212, no error / error_description in Location", async () => {
    const res = await callback("error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=s1");
    const url = location(res);
    expect(url.searchParams.get("ssoError")).toBe("SSO-1212");
    expect(url.searchParams.get("redirect")).toBe("/next/runs?page=2");
    expect(String(res.headers.location)).not.toMatch(/access_denied|script|alert/);
    expect(identity.handleOidcCallback).not.toHaveBeenCalled();
  });

  it("missing code / state -> SSO-1203 (no state: no redirect)", async () => {
    const url = location(await callback("code=c"));
    expect(url.searchParams.get("ssoError")).toBe("SSO-1203");
    expect(url.searchParams.has("redirect")).toBe(false);
    expect(location(await callback("state=s1")).searchParams.get("ssoError")).toBe("SSO-1203");
  });

  it.each(["SSO-1203", "SSO-1204", "SSO-1205", "SSO-1206", "SSO-1201", "SSO-1210"])("handleOidcCallback throws %s -> that code", async (code) => {
    identity.handleOidcCallback.mockRejectedValueOnce(new ForgeError(code, "x-detail-text", 401));
    const res = await callback("code=c&state=s1");
    const url = location(res);
    expect(url.searchParams.get("ssoError")).toBe(code);
    expect(url.searchParams.get("redirect")).toBe("/next/runs?page=2");
    expect(String(res.headers.location)).not.toContain("x-detail-text");
  });

  it("an unexpected error or a non-whitelisted code -> SYS-9001, no message in Location", async () => {
    identity.handleOidcCallback.mockRejectedValueOnce(new Error("boom-internal-detail"));
    const a = await callback("code=c&state=s1");
    expect(location(a).searchParams.get("ssoError")).toBe("SYS-9001");
    expect(String(a.headers.location)).not.toContain("boom");
    identity.handleOidcCallback.mockRejectedValueOnce(new ForgeError("CFG-8501", "<b>x</b>", 400));
    expect(location(await callback("code=c&state=s1")).searchParams.get("ssoError")).toBe("SYS-9001");
  });

  it("an off-site saved return target is dropped (S-30)", async () => {
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      identity.pendingOidcReturnTo.mockReturnValueOnce(bad);
      identity.handleOidcCallback.mockRejectedValueOnce(new ForgeError("SSO-1204", "x", 401));
      const res = await callback("code=c&state=s1");
      expect(location(res).searchParams.has("redirect")).toBe(false);
      expect(String(res.headers.location)).not.toContain("evil");
    }
  });

  it("HTP-4003 branch unchanged: 302 even for an API client", async () => {
    identity.handleOidcCallback.mockRejectedValueOnce(new ForgeError(OUTBOUND_BLOCKED_CODE, "x", 502));
    expect(location(await callback("code=c&state=s1", JSON_ONLY)).searchParams.get("ssoError")).toBe(OUTBOUND_BLOCKED_CODE);
  });

  it("an API client (Accept: application/json) still gets the JSON error", async () => {
    identity.handleOidcCallback.mockRejectedValueOnce(new ForgeError("SSO-1204", "OIDC 令牌交换失败", 401));
    const a = await callback("code=c&state=s1", JSON_ONLY);
    expect(a.statusCode).toBe(401);
    expect(a.json().error.code).toBe("SSO-1204");
    const b = await callback("code=c", JSON_ONLY);
    expect(b.statusCode).toBe(400);
    expect(b.json().error.code).toBe("SSO-1203");
    const c = await callback("error=access_denied&state=s1", JSON_ONLY);
    expect(c.statusCode).toBe(401);
    expect(c.json().error.code).toBe("SSO-1212");
  });

  it("the exported whitelist covers every redirect code", () => {
    expect([...SSO_ERROR_CODES].sort()).toEqual(
      ["HTP-4003", "SYS-9001", ...Array.from({ length: 12 }, (_, i) => `SSO-12${String(i + 1).padStart(2, "0")}`)].sort(),
    );
  });
});
