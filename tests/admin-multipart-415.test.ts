import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, RouteOptions } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item 8 (needs a *_test DB): @fastify/multipart is registered app-wide, so a multipart/form-data body reached every
// admin write handler as an empty body (defaults applied, sometimes 200). Now every POST / PUT / PATCH / DELETE under
// /admin/api answers 415 OPN-4505 for a multipart body before the handler runs (nothing written), unless the route
// explicitly declares `config: { multipartUpload: true }` (no route does today). Every route the app registers is
// collected with an onRoute hook, so a new admin write route is covered automatically.
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

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const FAKE_ID = "01J0000000000000000000ZZZZ";
const UPLOAD_ROUTE = `/admin/api/it-upload-${suffix}`;
let app: FastifyInstance;
let headers: Record<string, string> = {};
let userId = "";

const BOUNDARY = "----forge-it-boundary";
const multipart = (fields: Record<string, string>) =>
  Object.entries(fields).map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + `--${BOUNDARY}--\r\n`;
const multipartHeaders = () => ({ ...headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}` });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  app.post(UPLOAD_ROUTE, { config: { multipartUpload: true } }, async () => ({ ok: true }));
  await app.ready();
  const session = await realSession({ name: "IT mp", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  userId = await repos.createUser({ email: `it-mp-${suffix}@forge.local`, username: `it-mp-${suffix}`, displayName: "IT mp", role: "user", dataScope: "self", orgUnitId: ROOT });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_id = ?", [userId]);
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await execute("DELETE FROM agents WHERE `key` = ?", [`it-mp-${suffix}`]);
  await cleanupRealSessions();
  await app.close();
});

const writeRoutes = () => {
  const out: Array<{ method: string; url: string }> = [];
  for (const route of seen) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      if (!route.url.startsWith("/admin/api/") || route.url === UPLOAD_ROUTE) continue;
      out.push({ method, url: route.url });
    }
  }
  return out;
};

describe("item 8: multipart on admin write routes -> 415", () => {
  it("every admin POST / PUT / PATCH / DELETE route answers 415 OPN-4505 for a multipart body", async () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some((r) => r.method === "PATCH")).toBe(true);
    const wrong: string[] = [];
    for (const route of routes) {
      const url = route.url.replace(/:[A-Za-z]+/g, FAKE_ID);
      const res = await app.inject({ method: route.method as "POST", url, headers: multipartHeaders(), payload: multipart({ key: `it-mp-${suffix}`, role: "platform_admin" }) });
      const code = res.statusCode === 415 ? (res.json() as { error: { code: string } }).error.code : "";
      if (res.statusCode !== 415 || code !== "OPN-4505") wrong.push(`${route.method} ${route.url} -> ${res.statusCode} ${code}`);
    }
    expect(wrong).toEqual([]);
  });

  it("PATCH /users/{id} and POST /agents with multipart write nothing", async () => {
    const patch = await app.inject({ method: "PATCH", url: `/admin/api/users/${userId}`, headers: multipartHeaders(), payload: multipart({ role: "auditor", status: "disabled" }) });
    expect(patch.statusCode).toBe(415);
    const row = (await query<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [userId]))[0]!;
    expect(row).toEqual({ role: "user", status: "active" });
    const create = await app.inject({ method: "POST", url: "/admin/api/agents", headers: multipartHeaders(), payload: multipart({ key: `it-mp-${suffix}` }) });
    expect(create.statusCode).toBe(415);
    expect(await repos.getAgentByKey(`it-mp-${suffix}`)).toBeNull();
  });

  it("a route that declares config.multipartUpload still accepts multipart; JSON writes are unaffected", async () => {
    const upload = await app.inject({ method: "POST", url: UPLOAD_ROUTE, headers: multipartHeaders(), payload: multipart({ purpose: "input" }) });
    expect(upload.statusCode, upload.body).toBe(200);
    const json = await app.inject({ method: "PATCH", url: `/admin/api/users/${userId}`, headers, payload: { role: "user" } });
    expect(json.statusCode, json.body).toBe(200);
  });
});
