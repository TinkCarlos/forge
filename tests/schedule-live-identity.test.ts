import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { SCHEDULE_PAUSED_CODE, SCHEDULE_TRIGGER_FAILED_CODE, triggerSchedule } from "@forge/runtime";
import { execute, pool, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// S-45 / F-SCH / F-SM-04: when a schedule fires (automatic tick or manual "run now") its identity is re-read live:
// - bound service account: account status AND every department on its chain must be active;
// - legacy schedule (no service account): the user on the row (subject_type 'user' -> subject_id, else created_by)
//   must pass the same check as session auth (loadActivePrincipal).
// Unusable identity: automatic trigger pauses the schedule (SCD-4801), manual run -> 409 SCD-4801, no Run either way.
// Database error during the lookup: only this trigger fails (SCD-4803), the schedule stays active; manual -> 503 SYS-9003.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string) => `01JSL${tag}${suffix}`.toUpperCase().padEnd(26, "0").slice(0, 26);
const ORG_P = id26("P");
const ORG_C = id26("C");
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let accountId = "";
let userId = "";
const schedules: string[] = [];

async function makeSchedule(kind: "account" | "user" | "legacy-created-by"): Promise<string> {
  const id = await repos.createSchedule({
    key: `it-sl-${suffix}-${schedules.length}`, name: "IT live identity", agentId, orgUnitId: ORG_C,
    subjectType: kind === "account" ? "service" : kind === "user" ? "user" : "service",
    subjectId: kind === "account" ? accountId : kind === "user" ? userId : `svcleg${suffix}`.padEnd(26, "0").slice(0, 26),
    serviceAccountId: kind === "account" ? accountId : null,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "active", nextRunAt: new Date(Date.now() - 1000),
    createdBy: kind === "legacy-created-by" ? userId : ADMIN_ID,
  });
  schedules.push(id);
  return id;
}
const runsOf = async (scheduleId: string) => (await repos.listRuns({ limit: 300 })).filter((r) => r.trigger_ref === scheduleId);
const fire = async (scheduleId: string) => triggerSchedule((await repos.getSchedule(scheduleId))!);
const manual = async (scheduleId: string) => app.inject({ method: "POST", url: `/admin/api/schedules/${scheduleId}/run`, headers: await configurationHeaders(`/admin/api/schedules/${scheduleId}/run`, headers), payload: {} });
const setOrg = (id: string, status: string) => execute("UPDATE org_units SET status = ? WHERE id = ?", [status, id]);
const setUser = (status: string) => execute("UPDATE users SET status = ? WHERE id = ?", [status, userId]);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const admin = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(admin, sessionCookieValue(admin));
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, NULL, ?, 'IT sl P', ?)", [ORG_P, `it-sl-p-${suffix}`, `/it-sl-p-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, 'IT sl C', ?)", [ORG_C, ORG_P, `it-sl-c-${suffix}`, `/it-sl-p-${suffix}/it-sl-c-${suffix}/`]);
  agentId = await repos.createAgent({ key: `it-sl-agent-${suffix}`, name: "IT sl agent", ownerOrgUnitId: ORG_C, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId, version: "1.0.0", instructions: "Reply briefly.",
    spec: { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }], limits: { maxSteps: 2, maxCostUsd: 1 } },
    status: "published", createdBy: ADMIN_ID,
  }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  accountId = await repos.createServiceAccount({ key: `it-sl-svc-${suffix}`, name: "IT sl svc", orgUnitId: ORG_C, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  userId = await repos.createUser({ email: `it-sl-${suffix}@forge.local`, username: `it-sl-${suffix}`, displayName: "IT sl user", role: "operator", dataScope: "org", orgUnitId: ORG_C });
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const id of schedules) {
    await execute("UPDATE runs SET status = 'cancelled' WHERE trigger_type = 'schedule' AND trigger_ref = ? AND status = 'queued'", [id]);
    await execute("DELETE FROM runs WHERE trigger_type = 'schedule' AND trigger_ref = ? AND status NOT IN ('running')", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?)", [ORG_C, ORG_P]);
  await cleanupRealSessions();
  await app?.close();
});

const unusable: Array<{ name: string; kind: "account" | "user" | "legacy-created-by"; breakIt: () => Promise<unknown>; fixIt: () => Promise<unknown> }> = [
  { name: "service account, own department disabled", kind: "account", breakIt: () => setOrg(ORG_C, "disabled"), fixIt: () => setOrg(ORG_C, "active") },
  { name: "service account, parent department disabled", kind: "account", breakIt: () => setOrg(ORG_P, "disabled"), fixIt: () => setOrg(ORG_P, "active") },
  { name: "legacy user schedule, user's parent department disabled", kind: "user", breakIt: () => setOrg(ORG_P, "disabled"), fixIt: () => setOrg(ORG_P, "active") },
  { name: "legacy user schedule, user's own department disabled", kind: "user", breakIt: () => setOrg(ORG_C, "disabled"), fixIt: () => setOrg(ORG_C, "active") },
  { name: "legacy user schedule, user disabled", kind: "user", breakIt: () => setUser("disabled"), fixIt: () => setUser("active") },
  { name: "legacy user schedule, user deleted", kind: "user", breakIt: () => setUser("deleted"), fixIt: () => setUser("active") },
  { name: "legacy service schedule, creator's department disabled", kind: "legacy-created-by", breakIt: () => setOrg(ORG_P, "disabled"), fixIt: () => setOrg(ORG_P, "active") },
];

describe("schedule identity is re-validated live when it fires", () => {
  for (const c of unusable) {
    it(`${c.name}: tick pauses with SCD-4801, manual run 409 SCD-4801, no Run`, async () => {
      const auto = await makeSchedule(c.kind);
      const byHand = await makeSchedule(c.kind);
      await c.breakIt();
      try {
        expect(await fire(auto)).toEqual({ kind: "paused", code: SCHEDULE_PAUSED_CODE });
        const row = (await repos.getSchedule(auto))!;
        expect(row.status).toBe("disabled");
        expect(row.last_error_code).toBe(SCHEDULE_PAUSED_CODE);
        const res = await manual(byHand);
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: { code: string } }).error.code).toBe(SCHEDULE_PAUSED_CODE);
      } finally {
        await c.fixIt();
      }
      expect(await runsOf(auto)).toHaveLength(0);
      expect(await runsOf(byHand)).toHaveLength(0);
      // Healthy again: manual run works (proves the refusal came from the identity check).
      expect((await manual(byHand)).statusCode).toBe(200);
    });
  }

  it("healthy identities still run (service account, legacy user, legacy created_by)", async () => {
    for (const kind of ["account", "user", "legacy-created-by"] as const) {
      const result = await fire(await makeSchedule(kind));
      expect(result.kind).toBe("run");
    }
  });
});

describe("database error while resolving the schedule identity", () => {
  const failIdentityQueries = () => {
    const original = pool.query.bind(pool);
    return vi.spyOn(pool, "query").mockImplementation(((sql: unknown, params?: unknown) => {
      const text = typeof sql === "string" ? sql : String((sql as { sql?: string })?.sql ?? "");
      if (/FROM service_accounts|FROM users u/.test(text)) return Promise.reject(new Error("connect ETIMEDOUT 10.9.9.9:3306"));
      return original(sql as never, params as never);
    }) as never);
  };

  for (const kind of ["account", "user"] as const) {
    it(`${kind}: tick fails this trigger only (SCD-4803), schedule stays active; manual -> 503 SYS-9003`, async () => {
      const auto = await makeSchedule(kind);
      const byHand = await makeSchedule(kind);
      const spy = failIdentityQueries();
      let result;
      let res;
      try {
        result = await fire(auto);
        res = await manual(byHand);
      } finally {
        spy.mockRestore();
      }
      expect(result).toEqual({ kind: "failed", code: SCHEDULE_TRIGGER_FAILED_CODE });
      const row = (await repos.getSchedule(auto))!;
      expect(row.status).toBe("active");
      expect(row.next_run_at).not.toBeNull();
      expect(new Date(String(row.next_run_at)).getTime()).toBeGreaterThan(Date.now());
      expect(row.last_error_code).toBe(SCHEDULE_TRIGGER_FAILED_CODE);
      expect(res!.statusCode).toBe(503);
      expect((res!.json() as { error: { code: string } }).error.code).toBe("SYS-9003");
      expect(res!.body).not.toContain("10.9.9.9");
      expect(await runsOf(auto)).toHaveLength(0);
      expect(await runsOf(byHand)).toHaveLength(0);
      // Recovery: the same schedule fires normally next time.
      await execute("UPDATE schedules SET next_run_at = ? WHERE id = ?", [new Date(Date.now() - 1000), auto]);
      expect((await fire(auto)).kind).toBe("run");
    });
  }
});
