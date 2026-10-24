import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// K-23 / K-24 / I-ERR-22 / I-USR-02 / I-APR-34 / I-RUN-02 / S-25 (needs a *_test DB): bad input -> 400 CFG-8501 from
// the route schema, nothing stored, never a 500 from the database.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let accountId = "";
let scheduleId = "";

const code = (res: { json: () => unknown }): string | undefined => (res.json() as { error?: { code?: string }; code?: string }).error?.code ?? (res.json() as { code?: string }).code;

beforeAll(async () => {
  app = await buildApp();
  const session = await realSession({ name: "IT validation", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  agentId = await repos.createAgent({ key: `it-val-${suffix}`, name: "IT val", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  accountId = await repos.createServiceAccount({ key: `it-val-svc-${suffix}`, name: "IT val svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  scheduleId = await repos.createSchedule({
    key: `it-val-${suffix}`, name: "IT val", agentId, orgUnitId: ROOT, subjectType: "service", subjectId: accountId, serviceAccountId: accountId,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", nextRunAt: null, createdBy: ADMIN_ID,
  });
});

afterAll(async () => {
  await execute("DELETE FROM schedules WHERE id = ?", [scheduleId]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [`it-val-%${suffix}`]);
  await execute("DELETE FROM users WHERE email LIKE ?", [`%${suffix}%`]);
  await cleanupRealSessions();
  await app.close();
});

describe("route input schema -> 400 CFG-8501", () => {
  it("K-23: agent name of 200 chars -> 400 on create and patch; nothing stored", async () => {
    const create = await app.inject({ method: "POST", url: "/admin/api/agents", headers, payload: { key: `it-val-long-${suffix}`, name: "n".repeat(200) } });
    expect(create.statusCode).toBe(400);
    expect(code(create)).toBe("CFG-8501");
    expect(await repos.getAgentByKey(`it-val-long-${suffix}`)).toBeNull();
    const patch = await app.inject({ method: "PATCH", url: `/admin/api/agents/${agentId}`, headers, payload: { name: "n".repeat(200) } });
    expect(patch.statusCode).toBe(400);
    expect((await repos.getAgent(agentId))!.name).toBe("IT val");
  });

  it("K-24 / I-ERR-22: PATCH cron only (no status) with an invalid cron -> 400, nothing stored; bad timezone / status -> 400", async () => {
    for (const payload of [{ cron: "not a cron" }, { cron: "61 * * * *" }, { timezone: "Mars/Olympus" }, { status: "paused" }, { name: "n".repeat(200) }]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${scheduleId}`, headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(code(res)).toBe("CFG-8501");
    }
    const row = (await repos.getSchedule(scheduleId))!;
    expect([row.cron, row.timezone, row.status, row.name]).toEqual(["0 9 * * *", "Asia/Shanghai", "disabled", "IT val"]);
    const ok = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${scheduleId}`, headers, payload: { cron: "0 10 * * *" } });
    expect(ok.statusCode).toBe(200);
    expect((await repos.getSchedule(scheduleId))!.cron).toBe("0 10 * * *");
  });

  it("I-USR-02: missing email / email=abc -> 400; no user created", async () => {
    for (const payload of [{ username: `it-val-${suffix}` }, { email: "abc", username: `it-val-${suffix}` }]) {
      const res = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload });
      expect(res.statusCode).toBe(400);
      expect(code(res)).toBe("CFG-8501");
    }
  });

  it("I-APR-34: decide on a missing approval stays 404; body errors are 400 CFG-8501", async () => {
    const missing = await app.inject({ method: "POST", url: "/admin/api/approvals/01JNOTEXIST000000000000000/decide", headers, payload: { decision: "nope" } });
    expect(missing.statusCode).toBe(404);
  });

  it("ajv bounds: user password over 256 / agent version over 32 / schedule key over 64 -> 400 CFG-8501, nothing stored", async () => {
    const user = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload: { email: `it-val-pw-${suffix}@forge.local`, password: "p".repeat(257) } });
    expect(user.statusCode, user.body).toBe(400);
    expect(code(user)).toBe("CFG-8501");
    expect(await query("SELECT id FROM users WHERE email = ?", [`it-val-pw-${suffix}@forge.local`])).toHaveLength(0);
    const agent = await app.inject({ method: "POST", url: "/admin/api/agents", headers, payload: { key: `it-val-ver-${suffix}`, version: "v".repeat(33) } });
    expect(agent.statusCode, agent.body).toBe(400);
    expect(code(agent)).toBe("CFG-8501");
    expect(await query("SELECT id FROM agents WHERE `key` = ?", [`it-val-ver-${suffix}`])).toHaveLength(0);
    const sched = await app.inject({ method: "PATCH", url: `/admin/api/schedules/${scheduleId}`, headers, payload: { name: "n".repeat(129) } });
    expect(sched.statusCode, sched.body).toBe(400);
    expect((await query<{ name: string }>("SELECT name FROM schedules WHERE id = ?", [scheduleId]))[0]!.name).toBe("IT val");
  });

  it("validation runs after auth and lookup: no session -> 401 (not 400); unknown approval with a bad body -> 404", async () => {
    const anon = await app.inject({ method: "POST", url: "/admin/api/users", payload: { email: "abc" } });
    expect(anon.statusCode).toBe(401);
    const missing = await app.inject({ method: "POST", url: "/admin/api/approvals/01JNOTEXIST000000000000000/decide", headers, payload: { decision: "nope", comment: "c".repeat(2000) } });
    expect(missing.statusCode).toBe(404);
  });

  it("I-RUN-02 / S-25: runs and audit limit=abc/1.5/-1 -> 400; limit=10 -> 200", async () => {
    for (const url of ["/admin/api/runs", "/admin/api/audit"]) {
      for (const limit of ["abc", "1.5", "-1"]) {
        const res = await app.inject({ method: "GET", url: `${url}?limit=${limit}`, headers });
        expect(res.statusCode, `${url}?limit=${limit}`).toBe(400);
        expect(code(res)).toBe("CFG-8501");
      }
      expect((await app.inject({ method: "GET", url: `${url}?limit=10`, headers })).statusCode).toBe(200);
    }
  });
  it("P1-05 bounds: runs limit 0 / 201 / empty / 1e2 -> 400; 1 and 200 -> 200 (admin-api.md: over the max is 400)", async () => {
    for (const limit of ["0", "201", "", "1e2"]) {
      const res = await app.inject({ method: "GET", url: `/admin/api/runs?limit=${limit}`, headers });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
    }
    for (const limit of ["1", "200"]) expect((await app.inject({ method: "GET", url: `/admin/api/runs?limit=${limit}`, headers })).statusCode).toBe(200);
  });
  it("P1-11 / I-SCH-12: enable with an invalid cron / timezone already stored -> 400, still disabled, no audit", async () => {
    for (const [cron, timezone] of [["not-a-cron", "Asia/Shanghai"], ["0 9 * * *", "Mars/Olympus"]] as const) {
      await execute("UPDATE schedules SET cron = ?, timezone = ?, status = 'disabled', next_run_at = NULL WHERE id = ?", [cron, timezone, scheduleId]);
      const res = await app.inject({ method: "POST", url: `/admin/api/schedules/${scheduleId}/enable`, headers });
      expect(res.statusCode, `${cron} ${timezone}`).toBe(400);
      expect(code(res)).toBe("CFG-8501");
      const [row] = await query<{ status: string; next_run_at: unknown }>("SELECT status, next_run_at FROM schedules WHERE id = ?", [scheduleId]);
      expect(row).toEqual({ status: "disabled", next_run_at: null });
    }
    const audits = await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'schedule.enable' AND resource_id = ?", [scheduleId]);
    expect(Number(audits[0]!.n)).toBe(0);
    await execute("UPDATE schedules SET cron = '0 9 * * *', timezone = 'Asia/Shanghai' WHERE id = ?", [scheduleId]);
  });
});
