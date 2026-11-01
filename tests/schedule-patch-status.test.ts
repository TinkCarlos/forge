import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1 (F2 + F3, needs a *_test DB). F3: PATCH /admin/api/schedules/:id must not change status (it skipped every
// /enable check: stored cron, SCD-4801 service account, next_run_at); any status in the body -> 400 CFG-8501, nothing
// stored; enabling / disabling only through /enable and /disable. F2: PATCH, create and enable share one cron check
// (assertScheduleTiming): empty, 4-field and 6-field (seconds) expressions -> 400.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let accountId = "";
let disabledAccountId = "";
const schedules: string[] = [];

const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string; details?: { field?: string } } }).error;
const row = (id: string) => one<{ status: string; next_run_at: Date | null; cron: string; name: string }>("SELECT status, next_run_at, cron, name FROM schedules WHERE id = ?", [id]);
const updates = async (id: string) => (await query("SELECT id FROM audit_logs WHERE outcome = 'success' AND action = 'schedule.update' AND resource_id = ?", [id])).length;

async function schedule(tag: string, status: "active" | "disabled", opts: { cron?: string; serviceAccountId?: string } = {}): Promise<string> {
  const account = opts.serviceAccountId ?? accountId;
  const id = await repos.createSchedule({
    key: `it-sps-${tag}-${suffix}`, name: `IT sps ${tag}`, agentId, orgUnitId: ROOT, subjectType: "service", subjectId: account, serviceAccountId: account,
    cron: opts.cron ?? "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status, nextRunAt: status === "active" ? new Date(Date.now() + 3600_000) : null, createdBy: ADMIN_ID,
  });
  schedules.push(id);
  return id;
}
const patch = async (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/admin/api/schedules/${id}`, headers: await configurationHeaders(`/admin/api/schedules/${id}`, headers), payload });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT sps", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-sps-${suffix}`, name: "IT sps", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  accountId = await repos.createServiceAccount({ key: `it-sps-svc-${suffix}`, name: "IT sps svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  disabledAccountId = await repos.createServiceAccount({ key: `it-sps-off-${suffix}`, name: "IT sps off", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  await repos.updateServiceAccount(disabledAccountId, { status: "disabled" }, { expectedRevision: "system" });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type = 'schedule' AND resource_id IN (SELECT id FROM schedules WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM schedules WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM service_accounts WHERE id IN (?, ?)", [accountId, disabledAccountId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("F3: PATCH cannot change a schedule's status", () => {
  it("disabled + PATCH {status:'active'} with a disabled service account -> 400, still disabled, no next_run_at, no audit (enable answers SCD-4801)", async () => {
    const id = await schedule("off-acct", "disabled", { serviceAccountId: disabledAccountId });
    const res = await patch(id, { status: "active" });
    expect(res.statusCode).toBe(400);
    expect(code(res)?.code).toBe("CFG-8501");
    expect(code(res)?.details?.field).toBe("status");
    const after = await row(id);
    expect([after!.status, after!.next_run_at]).toEqual(["disabled", null]);
    expect(await updates(id)).toBe(0);
    const enable = await app.inject({ method: "POST", url: `/admin/api/schedules/${id}/enable`, headers: await configurationHeaders(`/admin/api/schedules/${id}/enable`, headers) });
    expect([enable.statusCode, code(enable)?.code]).toEqual([409, "SCD-4801"]);
  });

  it("disabled with a stored 6-field cron + PATCH {status:'active'} -> 400, still disabled", async () => {
    const id = await schedule("bad-cron", "disabled", { cron: "0 0 9 * * *" });
    const res = await patch(id, { status: "active" });
    expect(res.statusCode).toBe(400);
    expect((await row(id))!.status).toBe("disabled");
  });

  it("active + PATCH {status:'disabled'} -> 400, still active; any status in the body (even unchanged) -> 400", async () => {
    const id = await schedule("on", "active");
    for (const payload of [{ status: "disabled" }, { status: "active", name: "renamed" }, { status: "paused" }]) {
      const res = await patch(id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(code(res)?.code).toBe("CFG-8501");
    }
    const after = await row(id);
    expect([after!.status, after!.name]).toEqual(["active", "IT sps on"]);
    expect(await updates(id)).toBe(0);
  });

  it("PATCH without status still works; /enable and /disable still switch status", async () => {
    const id = await schedule("ok", "disabled");
    expect((await patch(id, { name: "renamed", cron: "0 10 * * *" })).statusCode).toBe(200);
    expect((await row(id))!.name).toBe("renamed");
    expect((await app.inject({ method: "POST", url: `/admin/api/schedules/${id}/enable`, headers: await configurationHeaders(`/admin/api/schedules/${id}/enable`, headers) })).statusCode).toBe(200);
    expect((await row(id))!.status).toBe("active");
    expect((await app.inject({ method: "POST", url: `/admin/api/schedules/${id}/disable`, headers: await configurationHeaders(`/admin/api/schedules/${id}/disable`, headers) })).statusCode).toBe(200);
    expect((await row(id))!.status).toBe("disabled");
  });
});

describe("F2: one cron check for PATCH, create and enable", () => {
  const BAD = ["", "   ", "0 9 * *", "0 0 9 * * *", "*/5 * * * * *"];

  it("PATCH cron empty / 4-field / 6-field -> 400 Cron 表达式无效, nothing stored", async () => {
    const id = await schedule("f2", "active");
    for (const cron of BAD) {
      const res = await patch(id, { cron });
      expect(res.statusCode, JSON.stringify(cron)).toBe(400);
      expect(code(res)?.details?.field).toBe("cron");
    }
    expect((await row(id))!.cron).toBe("0 9 * * *");
  });

  it("create with the same expressions -> 400; a 5-field cron is accepted", async () => {
    for (const cron of BAD) {
      const res = await app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { key: `it-sps-new-${suffix}`, agentId, serviceAccountId: accountId, cron } });
      expect(res.statusCode, JSON.stringify(cron)).toBe(400);
    }
    const ok = await app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { key: `it-sps-new-${suffix}`, agentId, serviceAccountId: accountId, cron: "0 9 * * 1" } });
    expect(ok.statusCode, ok.body).toBe(200);
    schedules.push((ok.json() as { id: string }).id);
  });

  it("enable with a stored 6-field cron -> 400, still disabled", async () => {
    const id = await schedule("f2-enable", "disabled", { cron: "*/5 * * * * *" });
    const res = await app.inject({ method: "POST", url: `/admin/api/schedules/${id}/enable`, headers: await configurationHeaders(`/admin/api/schedules/${id}/enable`, headers) });
    expect(res.statusCode).toBe(400);
    expect((await row(id))!.status).toBe("disabled");
  });
});
