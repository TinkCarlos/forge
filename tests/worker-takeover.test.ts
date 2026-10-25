import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// r5 takeover state machine (design §2, contract §3-§7). A worker that finds a tool call still `running` at the start
// of a round inherited it from an interrupted holder: a read-only tool is re-run in place (attempt + 1); a tool with
// side effects is never re-run automatically: it waits for a new `interrupted` approval (an old approval is never
// reused). Expired = rejected, never executed; expired beyond APPROVAL_EXPIRED_GRACE_SECONDS (default 900) fails the Run
// with APR-2102 without any further model or tool call. Approval 409s are APR-2104.
// Only the network edge is stubbed (safeFetch: the model at llm.invalid, the downstream API at down.invalid, counted;
// assertOutboundAllowed: no DNS); DB, runtime, capabilities and the API are real.
const downstream: Array<{ url: string; method: string }> = [];
let onDownstream: (() => Promise<void>) | null = null;
const modelReplies: Array<() => Response> = [];
let modelCalls = 0;
const safeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  if (target.hostname === "llm.invalid") {
    modelCalls += 1;
    const next = modelReplies.shift();
    return next ? next() : reply({ content: "done (default)" });
  }
  downstream.push({ url: target.toString(), method: String(init?.method ?? "GET") });
  const hook = onDownstream;
  onDownstream = null;
  if (hook) await hook();
  return new Response("downstream ok", { status: 200 });
});
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch,
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));

const { execute, one, query, repos } = await import("@forge/store");
const { claimRun, executeRun, runClaimed } = await import("@forge/runtime");
const { sessionCookieValue } = await import("@forge/identity");
const { buildApp } = await import("../apps/api/src/app.js");
const { cleanupRealSessions, realSession, sessionHeaders } = await import("./helpers/real-session.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `tk-${suffix}`;
const SOURCE_KEY = `tk-${suffix}`;
const WRITE = `openapi_${SOURCE_KEY}_write`.replace(/[^a-zA-Z0-9_-]/g, "_"); // POST, risk low, side effects
const SEND = `openapi_${SOURCE_KEY}_send`.replace(/[^a-zA-Z0-9_-]/g, "_"); // POST, risk high (policy approval)
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let providerId = "";
let sourceId = "";

type Call = { id?: string; type: "function"; function: { name: string; arguments: string } };
function reply(message: { content?: string; tool_calls?: Call[] }): Response {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
}
const call = (name: string, args: Record<string, unknown> = {}): Call => ({ type: "function", function: { name, arguments: JSON.stringify(args) } });

type ToolRow = { id: string; status: string; attempt: number; approval_id: string | null; result_text: string | null; tool_key: string };
type ApprovalRow = { id: string; status: string; reason: string; decided_by: string | null; comment: string | null; expires_at: Date; tool_call_id: string };
const toolRows = (runId: string) => query<ToolRow>("SELECT id, status, attempt, approval_id, result_text, tool_key FROM tool_calls WHERE run_id = ? ORDER BY created_at, step_index, id", [runId]);
const approvals = (runId: string) => query<ApprovalRow>("SELECT id, status, reason, decided_by, comment, expires_at, tool_call_id FROM approvals WHERE run_id = ? ORDER BY created_at, id", [runId]);
const runRow = async (runId: string) => (await one<{ status: string; claimed_by: string | null; error_code: string | null; error_message: string | null }>("SELECT status, claimed_by, error_code, error_message FROM runs WHERE id = ?", [runId]))!;
async function events(runId: string, type: string): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{ data_json: unknown }>("SELECT data_json FROM run_events WHERE run_id = ? AND type = ? ORDER BY seq", [runId, type]);
  return rows.map((row) => (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json) as Record<string, unknown>);
}
const toolMessages = async (runId: string) =>
  (await query<{ content_json: unknown }>("SELECT content_json FROM messages WHERE run_id = ? AND role = 'tool' ORDER BY seq", [runId])).map((row) => {
    const content = (typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json) as { text: string; tool_call_id: string };
    return content;
  });
const decideHttp = (id: string, decision: string) => app.inject({ method: "POST", url: `/admin/api/approvals/${id}/decide`, headers, payload: { decision } });
const audits = async (id: string) => (await query("SELECT id FROM audit_logs WHERE action = 'approval.decide' AND resource_id = ?", [id])).length;
const resetNet = () => {
  downstream.length = 0;
  modelReplies.length = 0;
  modelCalls = 0;
  onDownstream = null;
};

async function newRun(status = "queued", claimedBy: string | null = null): Promise<{ runId: string; threadId: string }> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status, claimedBy, leaseSeconds: claimedBy ? 30 : null });
  return { runId, threadId };
}

/**
 * A Run whose holder died while executing one tool call: the call row is `running` (attempt 1) with its read-only
 * snapshot, the assistant message that asked for it is stored, and the lease has expired.
 */
async function seedInterrupted(toolKey: string, readOnly: boolean, args: Record<string, unknown> = {}): Promise<{ runId: string; rowId: string }> {
  const { runId, threadId } = await newRun("running", "w-dead");
  const rowId = await repos.addToolCall({ runId, toolKey, args, risk: toolKey === SEND ? "high" : "low", status: "running", idempotencyKey: `${runId}:s2:0`, attempt: 1, readOnly, modelStep: 2, stepIndex: 0 });
  await repos.addMessage({ threadId, runId, seq: 1, role: "assistant", content: { text: "", tool_calls: [{ id: rowId, type: "function", function: { name: toolKey, arguments: JSON.stringify(args) } }] } });
  await repos.expireRunLease(runId, "w-dead");
  return { runId, rowId };
}

/** TK-02 state: an interrupted side-effect call taken over -> waiting on a new `interrupted` approval. */
async function seedWaitingInterrupted(): Promise<{ runId: string; rowId: string; approvalId: string }> {
  const seeded = await seedInterrupted(WRITE, false);
  await executeRun(seeded.runId, `w-new-${suffix}`);
  const [approval] = await approvals(seeded.runId);
  expect(approval?.reason).toBe("interrupted");
  return { ...seeded, approvalId: approval!.id };
}

/** What the worker's expiry sweep does for one Run: claim it allowing waiting_approval, then execute. */
async function sweepWake(runId: string): Promise<void> {
  const listed = await repos.listRunsWithExpiredApprovals(10000);
  expect(listed).toContain(runId);
  const claimed = await claimRun(runId, `w-sweep-${suffix}`, true);
  expect(claimed).not.toBeNull();
  await runClaimed(claimed!, `w-sweep-${suffix}`);
}
const setOverdue = (approvalId: string, ms: number) => execute("UPDATE approvals SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND) WHERE id = ?", [ms * 1000, approvalId]);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "TK stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  sourceId = await repos.createToolSource({ key: SOURCE_KEY, name: "tk", baseUrl: "https://down.invalid", spec: { paths: {} } });
  await repos.replaceTools(sourceId, [
    { name: "write", operationId: "write", method: "POST", path: "/w", readOnly: false, risk: "low" },
    { name: "send", operationId: "send", method: "POST", path: "/s", readOnly: false, risk: "high" },
  ]);
  agentId = await repos.createAgent({ key: `it-tk-${suffix}`, name: "IT TK", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "x",
    spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [{ builtin: ["echo"] }, { openapi: SOURCE_KEY }] },
    status: "published",
    createdBy: ADMIN_ID,
  });
});

afterAll(async () => {
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE p FROM approvals p JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE t FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (sourceId) {
    await execute("DELETE FROM tools WHERE source_id = ?", [sourceId]);
    await execute("DELETE FROM tool_sources WHERE id = ?", [sourceId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("takeover of a running tool call", () => {
  it("TK-01 read-only (snapshot read_only=1): re-run once in place, attempt 2, tool.interrupted rerun with attempt 1", async () => {
    resetNet();
    modelReplies.push(() => reply({ content: "done" }));
    const { runId, rowId } = await seedInterrupted("echo", true, { text: "again" });
    await executeRun(runId, `w-new-${suffix}`);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "succeeded", attempt: 2, result_text: "again" })]);
    expect(await events(runId, "tool.interrupted")).toEqual([{ toolCallId: rowId, tool: "echo", action: "rerun", attempt: 1, approvalId: null, previousApprovalId: null }]);
    expect(await events(runId, "tool.started")).toHaveLength(1);
    expect(await approvals(runId)).toEqual([]);
    expect((await runRow(runId)).status).toBe("succeeded");
    expect(downstream).toHaveLength(0);
  });

  it("TK-02 side effects (snapshot read_only=0): not executed, new interrupted approval, Run waiting, lease released", async () => {
    resetNet();
    const { runId, rowId } = await seedInterrupted(WRITE, false);
    await executeRun(runId, `w-new-${suffix}`);
    expect(downstream).toHaveLength(0);
    expect(modelCalls).toBe(0);
    const [approval, ...others] = await approvals(runId);
    expect(others).toEqual([]);
    expect(approval).toMatchObject({ reason: "interrupted", status: "pending", tool_call_id: rowId });
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "pending_approval", attempt: 1, approval_id: approval!.id })]);
    expect(await runRow(runId)).toMatchObject({ status: "waiting_approval", claimed_by: null });
    expect(await events(runId, "tool.interrupted")).toEqual([{ toolCallId: rowId, tool: WRITE, action: "confirm", attempt: 1, approvalId: approval!.id, previousApprovalId: null }]);
    expect(await events(runId, "approval.required")).toEqual([{ approvalId: approval!.id, toolCallId: rowId, tool: WRITE, risk: "low", reason: "interrupted", expiresAt: new Date(approval!.expires_at).toISOString() }]);
    expect(await events(runId, "tool.started")).toHaveLength(0);
  });

  it("TK-03/04 an approved call interrupted mid-execution: old approval not reused (decide -> 409 APR-2104), new one approved -> executed again (downstream 2)", async () => {
    resetNet();
    const { runId } = await newRun();
    // Worker 1: model asks for SEND (high risk) -> policy approval.
    modelReplies.push(() => reply({ content: "", tool_calls: [call(SEND, { to: "x" })] }));
    await executeRun(runId, `w-one-${suffix}`);
    const [policy] = await approvals(runId);
    expect(policy).toMatchObject({ reason: "policy", status: "pending" });
    const [row] = await toolRows(runId);
    expect(await events(runId, "approval.required")).toEqual([{ approvalId: policy!.id, toolCallId: row!.id, tool: SEND, risk: "high", reason: "policy", expiresAt: new Date(policy!.expires_at).toISOString() }]);
    // Approved; worker 1 executes and loses its lease while the downstream request is in flight (sent, result unknown).
    expect(await repos.decideApproval(policy!.id, "approved", ADMIN_ID, "")).toBe(true);
    onDownstream = async () => {
      await execute("UPDATE runs SET claimed_by = 'tk-thief' WHERE id = ?", [runId]);
    };
    await executeRun(runId, `w-one-${suffix}`);
    expect(downstream).toHaveLength(1);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: row!.id, status: "running", attempt: 1, approval_id: policy!.id })]);
    // Worker 2 takes over: no execution, a new interrupted approval.
    await repos.expireRunLease(runId, "tk-thief");
    await executeRun(runId, `w-two-${suffix}`);
    expect(downstream).toHaveLength(1);
    const all = await approvals(runId);
    expect(all.map((a) => [a.id === policy!.id, a.reason, a.status])).toEqual([[true, "policy", "approved"], [false, "interrupted", "pending"]]);
    const fresh = all[1]!;
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: row!.id, status: "pending_approval", approval_id: fresh.id })]);
    expect(await events(runId, "tool.interrupted")).toEqual([{ toolCallId: row!.id, tool: SEND, action: "confirm", attempt: 1, approvalId: fresh.id, previousApprovalId: policy!.id }]);
    // TK-04: deciding the old approval -> 409 APR-2104, nothing runs, no audit.
    const stale = await decideHttp(policy!.id, "approved");
    expect(stale.statusCode, stale.body).toBe(409);
    expect((stale.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "APR-2104", message: "审批已处理或已过期" });
    expect(await audits(policy!.id)).toBe(0);
    expect(downstream).toHaveLength(1);
    expect((await runRow(runId)).status).toBe("waiting_approval");
    // Approving the new one executes the same row once more (attempt 2).
    modelReplies.push(() => reply({ content: "done" }));
    expect(await repos.decideApproval(fresh.id, "approved", ADMIN_ID, "")).toBe(true);
    await executeRun(runId, `w-two-${suffix}`);
    expect(downstream).toHaveLength(2);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: row!.id, status: "succeeded", attempt: 2 })]);
    expect((await runRow(runId)).status).toBe("succeeded");
  });

  it("TK-05 interrupted approval rejected: call rejected (tool message says interrupted, not retried), Run continues, downstream unchanged", async () => {
    resetNet();
    const { runId, rowId, approvalId } = await seedWaitingInterrupted();
    modelReplies.push(() => reply({ content: "done" }));
    expect(await repos.decideApproval(approvalId, "rejected", ADMIN_ID, "")).toBe(true);
    await executeRun(runId, `w-new-${suffix}`);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "rejected" })]);
    const [message] = await toolMessages(runId);
    expect(message?.tool_call_id).toBe(rowId);
    expect(message?.text).toMatch(/interrupted/i);
    expect(message?.text).toMatch(/not (run|retried) again|not retried/i);
    expect(await events(runId, "approval.resolved")).toEqual([{ approvalId, decision: "rejected" }]);
    expect((await runRow(runId)).status).toBe("succeeded");
    expect(modelCalls).toBe(1);
    expect(downstream).toHaveLength(0);
  });
});

describe("approval expiry", () => {
  it("TK-09 interrupted approval expired (within grace): the sweep wakes the Run, approval expired, call rejected, Run continues", async () => {
    resetNet();
    const { runId, rowId, approvalId } = await seedWaitingInterrupted();
    await setOverdue(approvalId, 10_000);
    modelReplies.push(() => reply({ content: "done" }));
    await sweepWake(runId);
    expect((await approvals(runId))[0]).toMatchObject({ id: approvalId, status: "expired" });
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "rejected" })]);
    const [message] = await toolMessages(runId);
    expect(message?.text).toMatch(/interrupted/i);
    expect(message?.text).toMatch(/expired/i);
    expect(await events(runId, "approval.resolved")).toEqual([{ approvalId, decision: "expired" }]);
    expect((await runRow(runId)).status).toBe("succeeded");
    expect(downstream).toHaveLength(0);
    expect(await repos.listRunsWithExpiredApprovals(10000)).not.toContain(runId);
  });

  it("TK-09 the sweep lists only waiting Runs whose approval for a still pending_approval call has expired", async () => {
    resetNet();
    const live = await seedWaitingInterrupted();
    expect(await repos.listRunsWithExpiredApprovals(10000)).not.toContain(live.runId);
    await setOverdue(live.approvalId, 1_000);
    expect(await repos.listRunsWithExpiredApprovals(10000)).toContain(live.runId);
  });

  it("TK-10 decide approved on a pending but expired approval: 409 APR-2104, approval expired, no audit, nothing runs", async () => {
    resetNet();
    const { runId, rowId, approvalId } = await seedWaitingInterrupted();
    await setOverdue(approvalId, 5_000);
    const res = await decideHttp(approvalId, "approved");
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "APR-2104", message: "审批已处理或已过期" });
    expect((await approvals(runId))[0]?.status).toBe("expired");
    expect(await audits(approvalId)).toBe(0);
    expect(downstream).toHaveLength(0);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "pending_approval" })]);
  });

  it("TK-11 policy approval expired 2h ago (beyond grace): approval rejected by the system, call rejected, Run failed APR-2102, no model / tool call", async () => {
    resetNet();
    const { runId } = await newRun("waiting_approval");
    const sendRow = await repos.addToolCall({ runId, toolKey: SEND, args: {}, risk: "high", status: "pending", modelStep: 2, stepIndex: 0, idempotencyKey: `${runId}:s2:0` });
    const echoRow = await repos.addToolCall({ runId, toolKey: "echo", args: { text: "later" }, risk: "low", status: "pending", modelStep: 2, stepIndex: 1, idempotencyKey: `${runId}:s2:1`, readOnly: true });
    const { id: approvalId } = await repos.addApproval({ runId, toolCallId: sendRow, risk: "high", timeoutSeconds: 3600 });
    await execute("UPDATE approvals SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) WHERE id = ?", [approvalId]);
    await sweepWake(runId);
    expect((await approvals(runId))[0]).toMatchObject({ id: approvalId, status: "rejected", decided_by: null, comment: "审批过期超过宽限期，系统驳回" });
    expect((await toolRows(runId)).map((r) => [r.id, r.status])).toEqual([[sendRow, "rejected"], [echoRow, "pending"]]);
    expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "APR-2102", error_message: "审批已过期，Run 已终止" });
    const detail = await app.inject({ method: "GET", url: `/admin/api/runs/${runId}`, headers });
    expect(detail.json()).toMatchObject({ status: "failed", errorCode: "APR-2102", errorMessage: "审批已过期，Run 已终止" });
    expect((await events(runId, "run.failed")).map((e) => (e.error as { code: string }).code)).toEqual(["APR-2102"]);
    expect(modelCalls).toBe(0);
    expect(downstream).toHaveLength(0);
    expect(await events(runId, "tool.started")).toHaveLength(0);
  });

  it("TK-11/12 interrupted approval created by new code, left unswept beyond grace (rollback), then swept: Run failed APR-2102, no model / tool call", async () => {
    resetNet();
    const { runId, rowId, approvalId } = await seedWaitingInterrupted();
    // The new worker stops; old code never sweeps; the approval ends up expired for longer than the grace period.
    await setOverdue(approvalId, (900 + 120) * 1000);
    await sweepWake(runId);
    expect((await approvals(runId))[0]).toMatchObject({ id: approvalId, status: "rejected", decided_by: null, comment: "审批过期超过宽限期，系统驳回" });
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "rejected" })]);
    expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "APR-2102", error_message: "审批已过期，Run 已终止" });
    expect((await events(runId, "run.failed")).map((e) => (e.error as { code: string }).code)).toEqual(["APR-2102"]);
    expect(modelCalls).toBe(0);
    expect(downstream).toHaveLength(0);
  });

  it.each([
    [899, "continues"],
    [900, "continues"],
    [901, "fails"],
  ] as const)("TK-13 grace boundary (900 s): overdue %i s -> Run %s", async (seconds, outcome) => {
    resetNet();
    const { runId, rowId, approvalId } = await seedWaitingInterrupted();
    await setOverdue(approvalId, seconds * 1000 + 200); // TIMESTAMPDIFF floors: +200 ms still reads `seconds`
    modelReplies.push(() => reply({ content: "done" }));
    await sweepWake(runId);
    const [approval] = await approvals(runId);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: rowId, status: "rejected" })]);
    if (outcome === "continues") {
      expect(approval?.status).toBe("expired");
      expect((await runRow(runId)).status).toBe("succeeded");
      expect(modelCalls).toBe(1);
    } else {
      expect(approval?.status).toBe("rejected");
      expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "APR-2102" });
      expect(modelCalls).toBe(0);
    }
    expect(downstream).toHaveLength(0);
  });
});
