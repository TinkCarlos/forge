import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, type Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const createdAccounts: string[] = [];
const createdSchedules: string[] = [];
const ORG = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let agentId = "";
let versionId = "";
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
  agentId = await repos.createAgent({ key: `it-sa-agent-${suffix}`, name: "IT SA agent", ownerOrgUnitId: ORG, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  builderHeaders = { cookie: `forge_session=${sessionCookieValue(builderSession)}`, "x-csrf-token": builderSession.csrfToken };
});

afterAll(async () => {
  if (builderSession) destroySession(builderSession.token);
  for (const id of createdSchedules) {
    await execute("DELETE FROM audit_logs WHERE resource_type = 'schedule' AND resource_id = ?", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  if (versionId) await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  if (agentId) await execute("DELETE FROM agents WHERE id = ?", [agentId]);
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

describe("schedule binding to a service account", () => {
  const createSchedule = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url: "/admin/api/schedules", headers: adminHeaders, payload: { agentId, cron: "0 9 * * 1", timezone: "Asia/Shanghai", ...payload } });
  const newAccount = async (status: "active" | "disabled", orgUnitId = ORG): Promise<string> => {
    const id = await repos.createServiceAccount({ key: `it-sa-bind-${suffix}-${createdAccounts.length}`, name: "IT bind", orgUnitId, createdBy: ADMIN_ID });
    if (status === "disabled") await repos.updateServiceAccount(id, { status: "disabled" });
    createdAccounts.push(id);
    return id;
  };

  it("create requires serviceAccountId (400), rejects unknown (404) and disabled (409 SCD-4801)", async () => {
    expect((await createSchedule({ key: `it-sa-s0-${suffix}` })).statusCode).toBe(400);
    expect((await createSchedule({ key: `it-sa-s1-${suffix}`, serviceAccountId: `svc-none-${suffix}` })).statusCode).toBe(404);
    const disabled = await createSchedule({ key: `it-sa-s2-${suffix}`, serviceAccountId: await newAccount("disabled") });
    expect(disabled.statusCode).toBe(409);
    expect((disabled.json() as { error: { code: string } }).error.code).toBe("SCD-4801");
  });

  it("builder cannot bind a service account from another org (404)", async () => {
    const foreign = await newAccount("active", "01J0000000000000000000OTHR");
    const res = await app.inject({ method: "POST", url: "/admin/api/schedules", headers: builderHeaders, payload: { agentId, cron: "0 9 * * 1", serviceAccountId: foreign, key: `it-sa-s3-${suffix}` } });
    expect(res.statusCode).toBe(404);
  });

  it("valid binding: stored as service subject, exposed as serviceAccountId/failureCount/lastErrorCode; PATCH rebinding validated", async () => {
    const accountId = await newAccount("active");
    const res = await createSchedule({ key: `it-sa-s4-${suffix}`, serviceAccountId: accountId });
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { id: string }).id;
    createdSchedules.push(id);
    const row = (await repos.getSchedule(id))!;
    expect(row).toMatchObject({ service_account_id: accountId, subject_type: "service", subject_id: accountId, created_by: ADMIN_ID });
    const list = await app.inject({ method: "GET", url: "/admin/api/schedules", headers: adminHeaders });
    const item = (list.json() as { items: Array<Record<string, unknown>> }).items.find((entry) => entry.id === id)!;
    expect(item).toMatchObject({ serviceAccountId: accountId, failureCount: 0, lastErrorCode: null });

    const disabledId = await newAccount("disabled");
    const patchBad = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${id}`, headers: adminHeaders, payload: { serviceAccountId: disabledId } });
    expect(patchBad.statusCode).toBe(409);
    const otherId = await newAccount("active");
    const patchOk = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${id}`, headers: adminHeaders, payload: { serviceAccountId: otherId } });
    expect(patchOk.statusCode).toBe(200);
    expect((await repos.getSchedule(id))!.service_account_id).toBe(otherId);

    // enabling a schedule whose account is disabled is refused
    await repos.updateServiceAccount(otherId, { status: "disabled" });
    const enable = await app.inject({ method: "POST", url: `/admin/api/schedules/${id}/enable`, headers: adminHeaders, payload: {} });
    expect(enable.statusCode).toBe(409);
  });
});
