import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SCHEDULE_TRIGGER_FAILED_CODE, triggerSchedule } from "@forge/runtime";
import { execute, repos } from "@forge/store";

// I-SCH-17 / I-ERR-20: the scheduler parses cron (and timezone) before anything else. A bad expression records
// SCD-4803, disables the schedule and never creates a Run (previously the Run was queued first and the parse
// error only surfaced afterwards).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let agentId = "";
let versionId = "";
let accountId = "";
const schedules: string[] = [];

async function makeSchedule(cron: string, timezone = "Asia/Shanghai", agent = agentId): Promise<string> {
  const id = await repos.createSchedule({
    key: `it-cron-${suffix}-${schedules.length}`, name: "IT cron", agentId: agent, orgUnitId: ROOT, subjectType: "service", subjectId: accountId, serviceAccountId: accountId,
    cron, timezone, input: { text: "x" }, status: "active", nextRunAt: new Date(Date.now() - 1000), createdBy: ADMIN_ID,
  });
  schedules.push(id);
  return id;
}
const runsOf = async (id: string) => (await repos.listRuns({ limit: 300 })).filter((r) => r.trigger_ref === id);

beforeAll(async () => {
  agentId = await repos.createAgent({ key: `it-cron-${suffix}`, name: "IT cron", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  accountId = await repos.createServiceAccount({ key: `it-cron-svc-${suffix}`, name: "IT cron svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const id of schedules) {
    await execute("UPDATE runs SET status = 'cancelled' WHERE trigger_type = 'schedule' AND trigger_ref = ? AND status = 'queued'", [id]);
    await execute("DELETE FROM runs WHERE trigger_type = 'schedule' AND trigger_ref = ? AND status <> 'running'", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
});

describe("cron is parsed before the trigger does anything (I-SCH-17, I-ERR-20)", () => {
  for (const [cron, tz] of [["not a cron", "Asia/Shanghai"], ["61 * * * *", "Asia/Shanghai"], ["0 9 * * *", "Mars/Olympus_Mons"], ["", "Asia/Shanghai"]] as const) {
    it(`cron=${JSON.stringify(cron)} tz=${tz}: SCD-4803, disabled, no Run`, async () => {
      const id = await makeSchedule(cron, tz);
      const result = await triggerSchedule((await repos.getSchedule(id))!);
      expect(result).toEqual({ kind: "failed", code: SCHEDULE_TRIGGER_FAILED_CODE });
      const row = (await repos.getSchedule(id))!;
      expect(row.status).toBe("disabled");
      expect(row.next_run_at).toBeNull();
      expect(row.last_error_code).toBe(SCHEDULE_TRIGGER_FAILED_CODE);
      expect(Number(row.failure_count)).toBe(1);
      expect(await runsOf(id)).toHaveLength(0);
    });
  }

  it("bad cron wins over other failures (checked first): unpublished Agent + bad cron -> SCD-4803", async () => {
    const unpublished = await repos.createAgent({ key: `it-cron-unpub-${suffix}`, name: "IT cron unpub", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
    try {
      const id = await makeSchedule("bogus", "Asia/Shanghai", unpublished);
      expect(await triggerSchedule((await repos.getSchedule(id))!)).toEqual({ kind: "failed", code: SCHEDULE_TRIGGER_FAILED_CODE });
    } finally {
      await execute("DELETE FROM schedules WHERE agent_id = ?", [unpublished]);
      await execute("DELETE FROM agents WHERE id = ?", [unpublished]);
    }
  });

  it("valid cron still runs and advances next_run_at", async () => {
    const id = await makeSchedule("0 9 * * *");
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result.kind).toBe("run");
    expect(new Date(String((await repos.getSchedule(id))!.next_run_at)).getTime()).toBeGreaterThan(Date.now());
  });
});
