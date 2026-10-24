import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession } from "./helpers/real-session.js";

// I-DOC-16: JSON is the only body type the API reads. A body sent as text/plain (Fastify's default text parser used to
// hand the raw string to the route), XML, a form, or with no Content-Type at all -> 415 OPN-4505, on every entry
// point. application/json with a charset parameter is still parsed, and a POST without a body (no Content-Type,
// nothing to parse) still reaches the route.
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let cookie = "";
let csrf = "";

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const session = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  cookie = `forge_session=${sessionCookieValue(session)}`;
  csrf = session.csrfToken;
});
afterAll(async () => {
  await cleanupRealSessions();
  await app?.close();
});

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string; requestId?: string } }).error;
const routes: Array<{ name: string; url: string; headers: () => Record<string, string> }> = [
  { name: "admin", url: "/admin/api/agents", headers: () => ({ cookie, "x-csrf-token": csrf }) },
  { name: "local login", url: "/auth/local/login", headers: () => ({}) },
  { name: "open", url: "/open/v1/agents/demo-agent/runs", headers: () => ({ authorization: "Bearer fsk_invalid" }) },
];
const JSON_TEXT = JSON.stringify({ key: "x", email: "a@b.test", password: "x", input: { text: "hi" } });

describe("I-DOC-16: non-JSON bodies -> 415 OPN-4505", () => {
  for (const route of routes) {
    for (const contentType of ["text/plain", "text/plain; charset=utf-8", "TEXT/PLAIN", "application/xml", "text/xml", undefined]) {
      it(`${route.name}: Content-Type ${contentType ?? "(none)"} with a body -> 415`, async () => {
        const headers: Record<string, string> = { ...route.headers() };
        if (contentType) headers["content-type"] = contentType;
        const res = await app.inject({ method: "POST", url: route.url, headers, payload: JSON_TEXT });
        expect(res.statusCode, res.body).toBe(415);
        expect(errorOf(res)?.code).toBe("OPN-4505");
        expect(errorOf(res)?.requestId).toBeTruthy();
      });
    }

    it(`${route.name}: application/json; charset=utf-8 is parsed (not 415)`, async () => {
      const res = await app.inject({ method: "POST", url: route.url, headers: { ...route.headers(), "content-type": "application/json; charset=utf-8" }, payload: JSON_TEXT });
      expect(res.statusCode, res.body).not.toBe(415);
      expect(res.statusCode).toBeLessThan(500);
    });
  }

  it("a POST without a body and without Content-Type still reaches the route (logout -> 200)", async () => {
    const session = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
    const res = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken } });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("a bodyless admin action without Content-Type is not 415 (unknown run -> 404)", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/runs/run_doesnotexist/cancel", headers: { cookie, "x-csrf-token": csrf } });
    expect(res.statusCode, res.body).toBe(404);
  });
});
