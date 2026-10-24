import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "@forge/core";
import { claimRun, executeRun, leaseTiming, runClaimed } from "@forge/runtime";
import { execute, query, repos } from "@forge/store";

// P3-09 (architect ruling; needs a *_test DB): two workers executing the same Run at the same time persist exactly
// one result (one assistant message, one message.completed, one terminal run event, one succeeded model step), both
// when they race for the claim and when the second one reclaims an expired lease while the first is still running
// (the first one's writes are fenced by runs.claimed_by). The heartbeat tolerance is computed from the period the
// heartbeat timer actually uses.
// Gate for the overlap case: the first model call (worker A) waits inside the model call until the test opens it.
const gate = { armed: false, reached: () => {}, open: () => {} };
vi.mock("@forge/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forge/models")>();
  return {
    ...actual,
    callModel: async (...args: Parameters<typeof actual.callModel>) => {
      if (gate.armed) {
        gate.armed = false;
        const wait = new Promise<void>((resolve) => { gate.open = resolve; });
        gate.reached();
        await wait;
      }
      return actual.callModel(...args);
    },
  };
});
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let agentId = "";
let versionId = "";
const runs: string[] = [];

async function newRun(): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "race" } });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: "race" } });
  runs.push(runId);
  return runId;
}
async function results(runId: string) {
  const events = await repos.listEvents(runId, 0);
  const assistant = await query<{ id: string }>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant'", [runId]);
  const steps = await query<{ id: string }>("SELECT id FROM run_steps WHERE run_id = ? AND type = 'call_model' AND status = 'succeeded'", [runId]);
  const run = await repos.getRun(runId);
  return {
    status: run?.status,
    completed: events.filter((e) => e.type === "message.completed").length,
    terminal: events.filter((e) => e.type === "run.completed").length,
    assistant: assistant.length,
    modelSteps: steps.length,
  };
}
const ONE = { status: "succeeded", completed: 1, terminal: 1, assistant: 1, modelSteps: 1 };

beforeAll(async () => {
  agentId = await repos.createAgent({ key: `it-race-${suffix}`, name: "IT race", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, status: "published", createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const id of runs) {
    const run = await repos.getRun(id);
    for (const table of ["run_events", "messages", "run_steps", "tool_calls"]) await execute(`DELETE FROM ${table} WHERE run_id = ?`, [id]);
    await execute("DELETE FROM runs WHERE id = ?", [id]);
    if (run?.thread_id) await execute("DELETE FROM threads WHERE id = ?", [run.thread_id]);
  }
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
});

describe("P3-09 two workers on one Run", () => {
  it("racing for the claim: one result", async () => {
    for (let round = 0; round < 3; round += 1) {
      const runId = await newRun();
      await Promise.all([executeRun(runId, `w-a-${suffix}`), executeRun(runId, `w-b-${suffix}`)]);
      expect(await results(runId)).toEqual(ONE);
    }
  });

  it("second worker reclaims an expired lease while the first is inside its model call: one result", async () => {
    const runId = await newRun();
    const first = await claimRun(runId, `w-a-${suffix}`, false);
    expect(first).toBeTruthy();
    const reached = new Promise<void>((resolve) => { gate.reached = resolve; });
    gate.armed = true;
    const a = runClaimed(first!, `w-a-${suffix}`);
    await reached; // worker A is now inside its model call
    // A's lease expires (e.g. its heartbeats were lost) before A notices; worker B reclaims and runs the Run to the end.
    await execute("UPDATE runs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?", [runId]);
    await executeRun(runId, `w-b-${suffix}`);
    expect((await repos.getRun(runId))?.claimed_by).toBeNull();
    gate.open(); // A's model call returns: every write it tries now is fenced off
    await a.catch((error: Error) => expect(error.name).toBe("LeaseLostError"));
    expect(await results(runId)).toEqual(ONE);
  });

  it("the heartbeat tolerance uses the period the heartbeat timer actually runs at", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const runId = await newRun();
      await executeRun(runId, `w-hb-${suffix}`);
      const { intervalMs, toleranceMs } = leaseTiming(config.LEASE_TTL_SECONDS);
      const periods = spy.mock.calls.map((call) => call[1]);
      expect(periods).toContain(intervalMs);
      expect(toleranceMs).toBe(config.LEASE_TTL_SECONDS * 1000 - intervalMs);
    } finally {
      spy.mockRestore();
    }
  });
});
