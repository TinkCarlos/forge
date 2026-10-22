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
const created = { agents: [] as string[], versions: [] as string[], schedules: [] as string[], accounts: [] as string[] };

let unpublishedAgentId = "";
let agentId = "";
let activeAccountId = "";
let disabledAccountId = "";
const ACCOUNT_ORG = "01J0000000000000000000SVC0";

/** Cancels a still-queued test run (so no worker picks it up); if a worker already claimed it, waits (bounded) for it to finish. */
async function settle(runId: string): Promise<void> {
  await execute("UPDATE runs SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'queued'", [runId]);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const run = await repos.getRun(runId);
    if (!run || !["queued", "running"].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

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
  agentId = await repos.createAgent({ key: `it-sch-agent-${suffix}`, name: "IT scheduled agent", ownerOrgUnitId: ORG, createdBy: ADMIN_ID });
  created.agents.push(agentId);
  const versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "Reply briefly.",
    spec: { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }], limits: { maxSteps: 2, maxCostUsd: 1 } },
    status: "published",
    createdBy: ADMIN_ID,
  });
  created.versions.push(versionId);
  await repos.publishAgentVersion(agentId, versionId);
  activeAccountId = await repos.createServiceAccount({ key: `it-sch-svc-${suffix}`, name: "IT Svc Active", orgUnitId: ACCOUNT_ORG, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  disabledAccountId = await repos.createServiceAccount({ key: `it-sch-svc-off-${suffix}`, name: "IT Svc Disabled", orgUnitId: ORG, createdBy: ADMIN_ID });
  await repos.updateServiceAccount(disabledAccountId, { status: "disabled" });
  created.accounts.push(activeAccountId, disabledAccountId);
});

afterAll(async () => {
  for (const id of created.schedules) {
    for (const run of await repos.listRuns({ limit: 200 })) if (run.trigger_ref === id) await settle(run.id);
    await execute("DELETE FROM runs WHERE trigger_type = 'schedule' AND trigger_ref = ?", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  for (const id of created.accounts) await execute("DELETE FROM service_accounts WHERE id = ?", [id]);
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

describe("schedule identity (service account)", () => {
  it("runs as the service account: subject/org come from the account, failure counters reset", async () => {
    const id = await makeSchedule(agentId, { serviceAccountId: activeAccountId });
    await execute("UPDATE schedules SET failure_count = 2, last_error_code = 'SCD-4803' WHERE id = ?", [id]);
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result.kind).toBe("run");
    const runId = (result as { runId: string }).runId;
    const run = (await repos.getRun(runId))!;
    expect(run.subject_type).toBe("service");
    expect(run.subject_id).toBe(activeAccountId);
    expect(run.subject_id).not.toBe(ADMIN_ID);
    expect(run.org_unit_id).toBe(ACCOUNT_ORG);
    expect(run.trigger_type).toBe("schedule");
    const row = (await repos.getSchedule(id))!;
    expect(row.status).toBe("active");
    expect(Number(row.failure_count)).toBe(0);
    expect(row.last_error_code).toBeNull();
    expect(row.last_run_id).toBe(runId);
    await settle(runId);
  });

  it("disabled service account -> not run, paused (status disabled), SCD-4801, failure_count + 1", async () => {
    const id = await makeSchedule(agentId, { serviceAccountId: disabledAccountId });
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result).toEqual({ kind: "paused", code: "SCD-4801" });
    const row = (await repos.getSchedule(id))!;
    expect(row.status).toBe("disabled");
    expect(row.next_run_at).toBeNull();
    expect(row.last_error_code).toBe("SCD-4801");
    expect(Number(row.failure_count)).toBe(1);
    expect((await repos.listRuns({ limit: 200 })).some((run) => run.trigger_ref === id)).toBe(false);
  });

  it("missing service account -> paused with SCD-4801", async () => {
    const id = await makeSchedule(agentId);
    await execute("UPDATE schedules SET service_account_id = ? WHERE id = ?", [`svc-gone-${suffix}`.slice(0, 26), id]);
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result).toEqual({ kind: "paused", code: "SCD-4801" });
  });

  it("legacy schedule without service account keeps the previous identity (subject_id, org of schedule)", async () => {
    const id = await makeSchedule(agentId);
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result.kind).toBe("run");
    const run = (await repos.getRun((result as { runId: string }).runId))!;
    expect(run.subject_type).toBe("service");
    expect(run.subject_id).toBe(ADMIN_ID);
    expect(run.org_unit_id).toBe(ORG);
    await settle(run.id);
  });
});

describe("concurrency_policy = skip", () => {
  it("skips the tick while a previous run is in flight; advances next_run_at; not a failure", async () => {
    const id = await makeSchedule(agentId, { serviceAccountId: activeAccountId });
    const threadId = await repos.createThread({ agentId, orgUnitId: ACCOUNT_ORG, subjectType: "service", subjectId: activeAccountId });
    // Held by a fake worker with a long lease so no real worker claims it.
    const heldRunId = await repos.createRun({
      threadId, agentId, agentVersionId: created.versions[0]!, orgUnitId: ACCOUNT_ORG, subjectType: "service", subjectId: activeAccountId,
      triggerType: "schedule", triggerRef: id, input: { text: "held" }, status: "running", claimedBy: `it-hold-${suffix}`, leaseSeconds: 600,
    });
    const before = Date.now();
    const result = await triggerSchedule((await repos.getSchedule(id))!);
    expect(result).toEqual({ kind: "skipped", reason: "concurrency" });
    const row = (await repos.getSchedule(id))!;
    expect(row.status).toBe("active");
    expect(new Date(row.next_run_at as string | Date).getTime()).toBeGreaterThan(before);
    expect(Number(row.failure_count)).toBe(0);
    expect(row.last_error_code).toBeNull();
    const runs = (await repos.listRuns({ limit: 200 })).filter((run) => run.trigger_ref === id);
    expect(runs.map((run) => run.id)).toEqual([heldRunId]);
    await repos.updateRun(heldRunId, { status: "cancelled" });
  });
});
