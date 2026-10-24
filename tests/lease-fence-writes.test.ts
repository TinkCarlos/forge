import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { execute, LeaseLostError, one, query, repos, withRunLease } from "@forge/store";

// P3-09 (architect ruling 1): every write the runtime makes for a claimed Run carries the lease holder condition
// (runs.claimed_by = the worker), like the K-34 conditional UPDATE. Once another worker took the lease, a write by
// the original worker affects 0 rows, is rejected with LeaseLostError and changes no data. The current owner's writes,
// and writes outside a lease scope (admin paths), are unaffected.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
let agentId = "";
let versionId = "";

type Seeded = { runId: string; threadId: string; toolCallId: string; stepId: string; approvalId: string };

/** A running Run claimed by w-old with one tool call, one running step, one pending (already expired) approval; then
 * w-new takes the lease (expire + claim, as a reclaim does). */
async function seedTakenOver(): Promise<Seeded> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "running", claimedBy: "w-old", leaseSeconds: 30 });
  const toolCallId = await repos.addToolCall({ runId, toolKey: "web_fetch", args: { url: "https://example.com" }, risk: "medium", status: "running" });
  const stepId = await repos.addRunStep({ runId, type: "call_model" });
  const pendingCall = await repos.addToolCall({ runId, toolKey: "mail.send", args: {}, risk: "high", status: "pending" });
  const approvalId = await repos.addApproval({ runId, toolCallId: pendingCall, risk: "high", timeoutSeconds: 1 });
  await execute("UPDATE approvals SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?", [approvalId]);
  await repos.expireRunLease(runId, "w-old");
  const claimed = await repos.claimRun(runId, "w-new", 30, false);
  expect(claimed?.run.claimed_by).toBe("w-new");
  return { runId, threadId, toolCallId, stepId, approvalId };
}

async function snapshot(runId: string) {
  return {
    run: await one("SELECT status, output_json, usage_json, cost_usd, error_code, completed_at, claimed_by FROM runs WHERE id = ?", [runId]),
    messages: await query("SELECT id, seq, role, content_json FROM messages WHERE run_id = ? ORDER BY seq", [runId]),
    steps: await query("SELECT id, seq, type, status, error_code, summary_json, ended_at FROM run_steps WHERE run_id = ? ORDER BY seq", [runId]),
    events: await query("SELECT seq, type FROM run_events WHERE run_id = ? ORDER BY seq", [runId]),
    toolCalls: await query("SELECT id, tool_key, status, result_text, error_code, approval_id, attempt FROM tool_calls WHERE run_id = ? ORDER BY id", [runId]),
    approvals: await query("SELECT id, status, decided_at FROM approvals WHERE run_id = ? ORDER BY id", [runId]),
  };
}

function writes(s: Seeded): Array<[string, () => Promise<unknown>]> {
  return [
    ["updateRun", () => repos.updateRun(s.runId, { status: "succeeded", output: { text: "late" }, completedAt: new Date() })],
    ["addMessage", () => repos.addMessage({ threadId: s.threadId, runId: s.runId, seq: 99, role: "assistant", content: { text: "late" } })],
    ["addRunStep", () => repos.addRunStep({ runId: s.runId, type: "prepare_context", status: "succeeded" })],
    ["finishRunStep", () => repos.finishRunStep(s.stepId, { status: "succeeded" })],
    ["addToolCall", () => repos.addToolCall({ runId: s.runId, toolKey: "late_tool", args: {}, risk: "low", status: "pending" })],
    ["updateToolCall", () => repos.updateToolCall(s.toolCallId, { status: "succeeded", resultText: "late" })],
    ["addApproval", () => repos.addApproval({ runId: s.runId, toolCallId: s.toolCallId, risk: "high", timeoutSeconds: 60 })],
    ["timeoutApprovals", () => repos.timeoutApprovals(s.runId)],
    ["failRunningSteps", () => repos.failRunningSteps(s.runId, "call_model", "MDL-3001")],
    ["addEvent", () => repos.addEvent(s.runId, "message.completed", { text: "late" })],
  ];
}

beforeAll(async () => {
  agentId = await repos.createAgent({ key: `it-fence-${suffix}`, name: "IT fence", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
});

afterAll(async () => {
  if (!agentId) return;
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
});

describe("P3-09 lease-fenced writes (runs.claimed_by)", () => {
  it("after another worker took the lease, every write by the original worker is rejected and changes nothing", async () => {
    const seeded = await seedTakenOver();
    const before = await snapshot(seeded.runId);
    for (const [name, write] of writes(seeded)) {
      await expect(withRunLease(seeded.runId, "w-old", write), name).rejects.toBeInstanceOf(LeaseLostError);
    }
    expect(await snapshot(seeded.runId)).toEqual(before);
  });

  it("the current owner's writes go through (same values twice is not mistaken for a lost lease)", async () => {
    const seeded = await seedTakenOver();
    await withRunLease(seeded.runId, "w-new", async () => {
      for (const [, write] of writes(seeded)) await write();
      await repos.updateToolCall(seeded.toolCallId, { status: "succeeded", resultText: "late" });
      await repos.updateToolCall(seeded.toolCallId, { status: "succeeded", resultText: "late" });
      await repos.updateRun(seeded.runId, { status: "succeeded" });
      expect(await repos.failRunningSteps(seeded.runId, "call_model", "MDL-3001")).toBe(0);
    });
    const after = await snapshot(seeded.runId);
    expect(after.run).toMatchObject({ status: "succeeded", claimed_by: "w-new" });
    expect(after.messages).toHaveLength(1);
    expect(after.toolCalls.find((row) => row.id === seeded.toolCallId)).toMatchObject({ status: "succeeded", result_text: "late" });
    expect(after.approvals.find((row) => row.id === seeded.approvalId)).toMatchObject({ status: "expired" });
  });

  it("writes outside a lease scope (admin paths) are not fenced", async () => {
    const seeded = await seedTakenOver();
    await repos.updateRun(seeded.runId, { errorMessage: "admin note" });
    await repos.addEvent(seeded.runId, "run.cancel_requested", {});
    expect((await snapshot(seeded.runId)).events.at(-1)).toMatchObject({ type: "run.cancel_requested" });
  });

  it("a lease scope for one Run does not fence writes for another Run", async () => {
    const a = await seedTakenOver();
    const b = await seedTakenOver();
    await withRunLease(a.runId, "w-old", () => repos.updateRun(b.runId, { errorMessage: "other run" }));
    expect((await one<{ error_message: string }>("SELECT error_message FROM runs WHERE id = ?", [b.runId]))?.error_message).toBe("other run");
  });
});
