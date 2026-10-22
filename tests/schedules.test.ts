import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "@forge/core";
import { SCHEDULE_PAUSED_CODE, triggerSchedule } from "@forge/runtime";
import { execute, repos } from "@forge/store";

// Real-MySQL tests for schedule triggering. triggerSchedule() is called on our own rows only,
// never tickSchedules(), so other schedules in the shared database are not touched.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ORG = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const created = { agents: [] as string[], versions: [] as string[], schedules: [] as string[] };

let unpublishedAgentId = "";

async function makeSchedule(agentId: string, extra: { serviceAccountId?: string | null } = {}): Promise<string> {
  const id = await repos.createSchedule({
    key: `it-sch-${suffix}-${created.schedules.length}`,
    name: "IT schedule",
    agentId,
    orgUnitId: ORG,
    subjectType: "user",
    subjectId: ADMIN_ID,
    serviceAccountId: extra.serviceAccountId ?? null,
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    input: { text: "scheduled hello" },
    status: "active",
    nextRunAt: new Date(Date.now() - 1000),
    createdBy: ADMIN_ID,
  });
  created.schedules.push(id);
  return id;
}

beforeAll(async () => {
  if (!config.DATABASE_URL.includes("forge")) throw new Error("Schedule tests require the forge MySQL database");
  unpublishedAgentId = await repos.createAgent({ key: `it-sch-unpub-${suffix}`, name: "IT unpublished", ownerOrgUnitId: ORG, createdBy: ADMIN_ID });
  created.agents.push(unpublishedAgentId);
});

afterAll(async () => {
  for (const id of created.schedules) {
    await execute("DELETE FROM runs WHERE trigger_type = 'schedule' AND trigger_ref = ?", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  for (const id of created.versions) await execute("DELETE FROM agent_versions WHERE id = ?", [id]);
  for (const id of created.agents) {
    await execute("DELETE FROM threads WHERE agent_id = ?", [id]);
    await execute("DELETE FROM agents WHERE id = ?", [id]);
  }
});

describe("schedule failure recording", () => {
  it("unpublished Agent -> paused with SCD-4801, failure_count incremented, no run", async () => {
    const id = await makeSchedule(unpublishedAgentId);
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result).toEqual({ kind: "paused", code: SCHEDULE_PAUSED_CODE });
    const row = (await repos.getSchedule(id))!;
    expect(row.status).toBe("disabled");
    expect(row.next_run_at).toBeNull();
    expect(row.last_error_code).toBe("SCD-4801");
    expect(Number(row.failure_count)).toBe(1);
    const runs = await repos.listRuns({ limit: 200 });
    expect(runs.some((run) => run.trigger_ref === id)).toBe(false);
  });
});
