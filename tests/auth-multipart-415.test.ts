import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, RouteOptions } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { query } from "@forge/store";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item B (needs a *_test DB): like item 8 for /admin/api, every POST / PUT / PATCH / DELETE under /auth answers
// 415 OPN-4505 for a multipart body (@fastify/multipart is registered app-wide) before CSRF / auth and before the
// handler: logout keeps the session, login never reads an empty form. /open and /integration are not changed here.
const seen = vi.hoisted(() => [] as RouteOptions[]);
vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const create = mod.default as unknown as (...args: unknown[]) => FastifyInstance;
  const factory = ((...args: unknown[]) => {
    const instance = create(...args);
    instance.addHook("onRoute", (route) => {
      seen.push(route as RouteOptions);
    });
    return instance;
  }) as unknown as typeof mod.default;
  return { ...mod, default: factory, fastify: factory };
});
const { buildApp } = await import("../apps/api/src/app.js");

const ROOT = "01J00000000000000000000000";
const BOUNDARY = "----forge-it-auth-boundary";
const multipart = (fields: Record<string, string>) =>
  Object.entries(fields).map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + `--${BOUNDARY}--\r\n`;
const MULTIPART = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await cleanupRealSessions();
  await app.close();
});

const authWriteRoutes = () => {
  const out: Array<{ method: string; url: string }> = [];
  for (const route of seen) {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && route.url.startsWith("/auth/")) out.push({ method, url: route.url });
    }
  }
  return out;
};

describe("item B: multipart on /auth write routes -> 415", () => {
  it("every /auth POST / PUT / PATCH / DELETE route answers 415 OPN-4505", async () => {
    const routes = authWriteRoutes();
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining(["POST /auth/local/login", "POST /auth/logout"]));
    const wrong: string[] = [];
    for (const route of routes) {
      const res = await app.inject({ method: route.method as "POST", url: route.url, headers: MULTIPART, payload: multipart({ email: "a@b.c", password: "x" }) });
      const code = res.statusCode === 415 ? (res.json() as { error: { code: string } }).error.code : "";
      if (res.statusCode !== 415 || code !== "OPN-4505") wrong.push(`${route.method} ${route.url} -> ${res.statusCode} ${code}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a multipart logout keeps the session and writes no audit; the JSON logout still works", async () => {
    const session = await realSession({ name: "IT auth mp", role: "user", orgUnitId: ROOT, dataScope: "self" });
    const headers = sessionHeaders(session, sessionCookieValue(session));
    const res = await app.inject({ method: "POST", url: "/auth/logout", headers: { ...headers, ...MULTIPART }, payload: multipart({ a: "1" }) });
    expect(res.statusCode).toBe(415);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/auth/session", headers })).statusCode).toBe(200);
    expect(await query("SELECT id FROM audit_logs WHERE outcome = 'success' AND actor_id = ? AND action = 'auth.logout'", [session.userId])).toEqual([]);
    const json = await app.inject({ method: "POST", url: "/auth/logout", headers });
    expect(json.statusCode, json.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/session", headers })).statusCode).toBe(401);
  });

  it("a multipart Content-Type with a different case is refused too", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/local/login", headers: { "content-type": `Multipart/Form-Data; boundary=${BOUNDARY}` }, payload: multipart({ email: "a@b.c" }) });
    expect(res.statusCode).toBe(415);
  });
});
