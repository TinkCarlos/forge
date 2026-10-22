import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, type Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const createdAccounts: string[] = [];
let app: FastifyInstance;
let adminHeaders: Record<string, string> = {};
let builderSession: Session;
let builderHeaders: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/local/login", payload: { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((c) => c.name === "forge_session")!;
  adminHeaders = { cookie: `forge_session=${cookie.value}`, "x-csrf-token": (login.json() as { csrfToken: string }).csrfToken };
  const builder: Principal = { type: "user", id: `it-builder-${suffix}`, name: "IT Builder", role: "builder", orgUnitId: "01J00000000000000000000000", dataScope: "org" };
  builderSession = createSession(builder);
  builderHeaders = { cookie: `forge_session=${sessionCookieValue(builderSession)}`, "x-csrf-token": builderSession.csrfToken };
});

afterAll(async () => {
  if (builderSession) destroySession(builderSession.token);
  for (const id of createdAccounts) {
    await execute("DELETE FROM audit_logs WHERE resource_type = 'service_account' AND resource_id = ?", [id]);
    await execute("DELETE FROM service_accounts WHERE id = ?", [id]);
  }
  if (adminHeaders.cookie) await app.inject({ method: "POST", url: "/auth/logout", headers: adminHeaders });
  await app?.close();
});

describe("service accounts admin API", () => {
  it("create -> list/get -> disable, audit-logged", async () => {
    const create = await app.inject({ method: "POST", url: "/admin/api/service-accounts", headers: adminHeaders, payload: { key: `it-svc-${suffix}`, name: "IT Service", role: "operator", dataScope: "org" } });
    expect(create.statusCode).toBe(200);
    const id = (create.json() as { id: string }).id;
    createdAccounts.push(id);
    expect(id.startsWith("svc")).toBe(true);

    const list = await app.inject({ method: "GET", url: "/admin/api/service-accounts", headers: adminHeaders });
    expect((list.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === id)).toBe(true);
    const get = await app.inject({ method: "GET", url: `/admin/api/service-accounts/${id}`, headers: adminHeaders });
    expect(get.json()).toMatchObject({ id, key: `it-svc-${suffix}`, role: "operator", dataScope: "org", status: "active" });

    const disable = await app.inject({ method: "PATCH", url: `/admin/api/service-accounts/${id}`, headers: adminHeaders, payload: { status: "disabled" } });
    expect(disable.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/admin/api/service-accounts/${id}`, headers: adminHeaders });
    expect(after.json()).toMatchObject({ status: "disabled" });
  });

  it("rejects invalid role / data scope / status and duplicate key", async () => {
    const bad = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> => app.inject({ method: "POST", url: "/admin/api/service-accounts", headers: adminHeaders, payload });
    expect((await bad({ name: "x", role: "nope" })).statusCode).toBe(400);
    expect((await bad({ name: "x", dataScope: "self" })).statusCode).toBe(400);
    expect((await bad({ role: "user" })).statusCode).toBe(400);
    const key = `it-svc-dup-${suffix}`;
    const first = await bad({ key, name: "dup" });
    createdAccounts.push((first.json() as { id: string }).id);
    expect((await bad({ key, name: "dup" })).statusCode).toBe(409);
    const patch = await app.inject({ method: "PATCH", url: `/admin/api/service-accounts/${createdAccounts.at(-1)}`, headers: adminHeaders, payload: { status: "paused" } });
    expect(patch.statusCode).toBe(400);
  });

  it("requires service_account.manage (builder -> 403) and CSRF on writes", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/api/service-accounts", headers: builderHeaders })).statusCode).toBe(403);
    const noCsrf = await app.inject({ method: "POST", url: "/admin/api/service-accounts", headers: { cookie: adminHeaders.cookie! }, payload: { name: "x" } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("unknown id -> 404", async () => {
    expect((await app.inject({ method: "GET", url: `/admin/api/service-accounts/svc-missing-${suffix}`, headers: adminHeaders })).statusCode).toBe(404);
  });
});
