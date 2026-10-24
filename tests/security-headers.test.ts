import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1-06 / S-10 (needs a *_test DB for the SSE case): every response carries CSP, nosniff, X-Frame-Options and
// Referrer-Policy - HTML, API, 404, 400, static assets and the SSE stream. Each header is its own assertion.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
const ids: Record<string, string> = {};

type Hdrs = Record<string, string | string[] | number | undefined>;
function checkHeaders(h: Hdrs, label: string): void {
  const csp = String(h["content-security-policy"] ?? "");
  expect(csp, `${label} CSP`).toContain("default-src 'self'");
  expect(csp, `${label} CSP object-src`).toContain("object-src 'none'");
  expect(csp, `${label} CSP frame-ancestors`).toContain("frame-ancestors 'none'");
  expect(csp, `${label} CSP no unsafe-eval`).not.toContain("unsafe-eval");
  expect(h["x-content-type-options"], `${label} nosniff`).toBe("nosniff");
  expect(h["x-frame-options"], `${label} XFO`).toBe("DENY");
  expect(["no-referrer", "strict-origin-when-cross-origin"], `${label} Referrer-Policy`).toContain(h["referrer-policy"]);
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const session = await realSession({ name: "IT headers", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  ids.agent = await repos.createAgent({ key: `it-hdr-${suffix}`, name: "IT hdr", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  ids.version = await repos.createAgentVersion({ agentId: ids.agent, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  ids.thread = await repos.createThread({ agentId: ids.agent, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  ids.run = await repos.createRun({ threadId: ids.thread, agentId: ids.agent, agentVersionId: ids.version, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "succeeded" });
});

afterAll(async () => {
  await execute("DELETE FROM run_events WHERE run_id = ?", [ids.run]);
  await execute("DELETE FROM runs WHERE id = ?", [ids.run]);
  await execute("DELETE FROM threads WHERE id = ?", [ids.thread]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [ids.version]);
  await execute("DELETE FROM agents WHERE id = ?", [ids.agent]);
  await cleanupRealSessions();
  await app.close();
});

describe("security headers on every response", () => {
  const cases: Array<[string, () => Promise<{ statusCode: number; headers: Hdrs }>]> = [
    ["GET /next/", () => app.inject({ method: "GET", url: "/next/" })],
    ["GET /next/agents (SPA fallback)", () => app.inject({ method: "GET", url: "/next/agents" })],
    ["GET / (legacy console)", () => app.inject({ method: "GET", url: "/" })],
    ["GET /auth/session (401)", () => app.inject({ method: "GET", url: "/auth/session" })],
    ["GET 404", () => app.inject({ method: "GET", url: "/no-such-route-" + suffix })],
    ["POST bad JSON (400)", () => app.inject({ method: "POST", url: "/auth/local/login", headers: { "content-type": "application/json" }, payload: "{bad" })],
    ["GET /assets/app.js (static)", () => app.inject({ method: "GET", url: "/assets/app.js" })],
    ["GET /healthz", () => app.inject({ method: "GET", url: "/healthz" })],
  ];
  for (const [label, run] of cases) {
    it(label, async () => checkHeaders((await run()).headers, label));
  }
  it("SSE stream keeps its own headers and gains the security headers", async () => {
    const res = await app.inject({ method: "GET", url: `/admin/api/runs/${ids.run}/events`, headers });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    expect(res.body).toContain(": forge stream");
    checkHeaders(res.headers, "SSE");
  });
  it("new console policy has no unsafe-inline at all; only the legacy page allows inline attributes", async () => {
    const next = String((await app.inject({ method: "GET", url: "/next/" })).headers["content-security-policy"]);
    expect(next).not.toContain("unsafe-inline");
    expect(next).toContain("script-src 'self'");
    const legacy = String((await app.inject({ method: "GET", url: "/" })).headers["content-security-policy"]);
    expect(legacy).toContain("script-src 'self'");
    expect(legacy).not.toMatch(/script-src [^;]*unsafe-inline/);
  });
  it("API and asset responses never relax the policy (no unsafe-inline anywhere)", async () => {
    for (const url of ["/auth/session", "/admin/api/agents", "/healthz", "/assets/app.js", "/index.html?x=1#/"]) {
      const res = await app.inject({ method: "GET", url, headers: url.startsWith("/admin") ? headers : {} });
      const csp = String(res.headers["content-security-policy"]);
      if (url.startsWith("/index.html")) expect(csp, url).not.toMatch(/script-src [^;]*unsafe-inline/);
      else expect(csp, url).not.toContain("unsafe-inline");
    }
  });
  it("S-10 legacy-page relaxation is recorded as a temporary, architect-approved exception (doc + code)", () => {
    const doc = readFileSync(new URL("../docs/02-architecture/permissions.md", import.meta.url), "utf8");
    expect(doc).toMatch(/S-10[^\n]*临时例外/);
    expect(doc).toContain("script-src-attr 'unsafe-inline'");
    const code = readFileSync(new URL("../apps/api/src/plugins/security-headers.ts", import.meta.url), "utf8");
    expect(code).toContain("TEMPORARY EXCEPTION (S-10)");
  });
});
