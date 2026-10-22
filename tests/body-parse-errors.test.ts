import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession } from "./helpers/real-session.js";

// K-09 / I-CSRF-06: a body that cannot be parsed is a client error, never 500 SYS-9001.
// - too large -> 413 OPN-4504; malformed JSON / declared JSON but empty -> 400 CFG-8501; unsupported Content-Type -> 415 OPN-4505.
// Middleware order is unchanged: parsing happens before the CSRF preHandler, so a broken body without a CSRF token
// is still answered by the parser (400/413/415), and a well-formed body without CSRF is still 403.
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

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; requestId?: string } }).error;
const BIG = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024 + 10) });

const routes: Array<{ name: string; url: string; headers: () => Record<string, string> }> = [
  { name: "admin (session + csrf)", url: "/admin/api/agents", headers: () => ({ cookie, "x-csrf-token": csrf }) },
  { name: "admin (session, no csrf)", url: "/admin/api/agents", headers: () => ({ cookie }) },
  { name: "local login", url: "/auth/local/login", headers: () => ({}) },
  { name: "open", url: "/open/v1/agents/demo-agent/runs", headers: () => ({ authorization: "Bearer fsk_invalid" }) },
];

const cases: Array<{ name: string; contentType: string; payload: string; status: number; code: string }> = [
  { name: "body too large", contentType: "application/json", payload: BIG, status: 413, code: "OPN-4504" },
  { name: "malformed JSON", contentType: "application/json", payload: '{"text": "x",', status: 400, code: "CFG-8501" },
  { name: "malformed JSON (charset param)", contentType: "application/json; charset=utf-8", payload: "{oops}", status: 400, code: "CFG-8501" },
  { name: "declared JSON, empty body", contentType: "application/json", payload: "", status: 400, code: "CFG-8501" },
  { name: "unsupported Content-Type", contentType: "application/xml", payload: "<a/>", status: 415, code: "OPN-4505" },
  { name: "unsupported Content-Type (form)", contentType: "application/x-www-form-urlencoded", payload: "a=1", status: 415, code: "OPN-4505" },
];

describe("body parse failures (K-09, I-CSRF-06)", () => {
  for (const route of routes) {
    for (const c of cases) {
      it(`${route.name}: ${c.name} -> ${c.status} ${c.code}`, async () => {
        const res = await app.inject({ method: "POST", url: route.url, headers: { ...route.headers(), "content-type": c.contentType }, payload: c.payload });
        expect(res.statusCode, res.body).toBe(c.status);
        const error = errorOf(res);
        expect(error.code).toBe(c.code);
        expect(error.requestId).toBeTruthy();
        expect(res.body).not.toContain("SYS-9001");
      });
    }
  }

  it("well-formed JSON without CSRF is still 403 (CSRF check unchanged, after parsing)", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/agents", headers: { cookie, "content-type": "application/json" }, payload: { key: "x" } });
    expect(res.statusCode).toBe(403);
  });
});
