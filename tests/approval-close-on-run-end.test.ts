import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// Architect ruling (front-end observation 2): when a Run reaches any terminal status (cancelled, failed, succeeded,
// failed because an approval expired beyond the grace period) its still pending approvals are closed in the same
// transaction as the Run's status change: status `expired` (existing value, the same one the decide path already uses
// for "Run 已结束"). They leave the pending list; deciding one afterwards is 409 (APR-2104, the approval is no longer
// pending; RUN-7005 stays as the fallback for an approval still pending on a finished Run); the tool call never runs.
// Architect ruling 15:26: after the commit, one `approval.resolved {approvalId, decision:"expired"}` (no `status` field)
// per closed approval, through run_events, before the Run's terminal event. A rolled-back close (lease lost) emits none.
// Only the network edge is stubbed (safeFetch counts downstream calls; assertOutboundAllowed: no DNS).
const downstream: string[] = [];
const safeFetch = vi.fn(async (url: string | URL) => {
  const target = new URL(String(url));
  if (target.hostname === "llm.invalid") {
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  downstream.push(target.toString());
  return new Response("downstream ok", { status: 200 });
});
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch,
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));

const { execute, LeaseLostError, one, query, repos, withRunLease } = await import("@forge/store");
const { claimRun, executeRun, finalize, runClaimed } = await import("@forge/runtime");
const { sessionCookieValue } = await import("@forge/identity");
const { buildApp } = await import("../apps/api/src/app.js");
const { cleanupRealSessions, realSession, sessionHeaders } = await import("./helpers/real-session.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `acr-${suffix}`;
const SOURCE_KEY = `acr-${suffix}`;
const SEND = `openapi_${SOURCE_KEY}_send`.replace(/[^a-zA-Z0-9_-]/g, "_");
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let providerId = "";
let sourceId = "";

type Seeded = { runId: string; threadId: string; rowId: string; approvalId: string };
async function seedWaiting(status = "waiting_approval", claimedBy: string | null = null): Promise<Seeded> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status, claimedBy, leaseSeconds: claimedBy ? 30 : null });
  const { rowId, approvalId } = await addPendingCall(runId, threadId, 1);
  return { runId, threadId, rowId, approvalId };
}
async function addPendingCall(runId: string, threadId: string, step: number, timeoutSeconds = 3600): Promise<{ rowId: string; approvalId: string }> {
  const rowId = await repos.addToolCall({ runId, toolKey: SEND, args: {}, risk: "high", status: "pending", idempotencyKey: `${runId}:s${step}:0`, readOnly: false, modelStep: step, stepIndex: 0 });
  await repos.addMessage({ threadId, runId, seq: step * 2, role: "assistant", content: { text: "", tool_calls: [{ id: rowId, type: "function", function: { name: SEND, arguments: "{}" } }] } });
  const approval = await repos.addApproval({ runId, toolCallId: rowId, risk: "high", timeoutSeconds });
  return { rowId, approvalId: approval.id };
}
const approvalStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM approvals WHERE id = ?", [id]))!.status;
const toolStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM tool_calls WHERE id = ?", [id]))!.status;
const runStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM runs WHERE id = ?", [id]))!.status;
type EventRow = { seq: number; type: string; data_json: unknown };
async function runEvents(runId: string): Promise<Array<{ seq: number; type: string; data: Record<string, unknown> }>> {
  const rows = await query<EventRow>("SELECT seq, type, data_json FROM run_events WHERE run_id = ? ORDER BY seq", [runId]);
  return rows.map((row) => ({ seq: Number(row.seq), type: row.type, data: (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json) as Record<string, unknown> }));
}
const TERMINAL_EVENTS = ["run.completed", "run.failed", "run.cancelled", "run.budget_exhausted"];

/** One approval.resolved {approvalId, decision:"expired"} (no status) per closed approval, all before the terminal event. */
async function expectResolvedBeforeTerminal(runId: string, closedIds: string[], terminalType: string): Promise<void> {
  const all = await runEvents(runId);
  const terminal = all.filter((event) => TERMINAL_EVENTS.includes(event.type));
  expect(terminal.map((event) => event.type)).toEqual([terminalType]);
  const expired = all.filter((event) => event.type === "approval.resolved" && event.data.decision === "expired");
  expect(expired.map((event) => event.data).sort((a, b) => String(a.approvalId).localeCompare(String(b.approvalId))))
    .toEqual([...closedIds].sort().map((approvalId) => ({ approvalId, decision: "expired" })));
  for (const event of expired) {
    expect(Object.keys(event.data).sort()).toEqual(["approvalId", "decision"]);
    expect(event.data).not.toHaveProperty("status");
    expect(event.seq).toBeLessThan(terminal[0]!.seq);
  }
}
const resolvedEvents = async (runId: string) => (await runEvents(runId)).filter((event) => event.type === "approval.resolved");

const decide = (id: string, decision = "approved") => app.inject({ method: "POST", url: `/admin/api/approvals/${id}/decide`, headers, payload: { decision } });

/** Every pending approval id the admin list shows (all pages). */
async function pendingListed(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page += 1) {
    const res = await app.inject({ method: "GET", url: `/admin/api/approvals?page=${page}&pageSize=100`, headers });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Array<{ id: string }>; total: number };
    for (const item of body.items) ids.add(item.id);
    if (body.items.length < 100 || page * 100 >= body.total) return ids;
  }
}

/** After the Run ended: not listed, closed as expired, deciding is 409 (APR-2104 or RUN-7005), the call never runs. */
async function expectClosed(seeded: { runId: string; rowId: string; approvalId: string }): Promise<void> {
  expect(await approvalStatus(seeded.approvalId)).toBe("expired");
  expect((await pendingListed()).has(seeded.approvalId)).toBe(false);
  const res = await decide(seeded.approvalId);
  expect(res.statusCode, res.body).toBe(409);
  expect(["APR-2104", "RUN-7005"]).toContain((res.json() as { error: { code: string } }).error.code);
  await executeRun(seeded.runId, `w-after-${suffix}`); // what the decide path would start: nothing to claim
  expect(downstream).toHaveLength(0);
  expect(await toolStatus(seeded.rowId)).not.toBe("succeeded");
  expect(await approvalStatus(seeded.approvalId)).toBe("expired");
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "ACR stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  sourceId = await repos.createToolSource({ key: SOURCE_KEY, name: "acr", baseUrl: "https://down.invalid", spec: { paths: {} } });
  await repos.replaceTools(sourceId, [{ name: "send", operationId: "send", method: "POST", path: "/s", readOnly: false, risk: "high" }]);
  agentId = await repos.createAgent({ key: `it-acr-${suffix}`, name: "IT ACR", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "x",
    spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [{ openapi: SOURCE_KEY }] },
    status: "published",
    createdBy: ADMIN_ID,
  }, { expectedRevision: "system" });
});

afterAll(async () => {
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN runs r ON r.id = a.resource_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE e FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE s FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE m FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.agent_id = ?", [agentId]);
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

describe("a Run reaching a terminal status closes its pending approvals", () => {
  it("cancelled (POST /admin/api/runs/:id/cancel): gone from the pending list, decide -> 409, the call never runs", async () => {
    downstream.length = 0;
    const seeded = await seedWaiting();
    expect((await pendingListed()).has(seeded.approvalId)).toBe(true); // control: listed while the Run waits
    const res = await app.inject({ method: "POST", url: `/admin/api/runs/${seeded.runId}/cancel`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(await runStatus(seeded.runId)).toBe("cancelled");
    await expectResolvedBeforeTerminal(seeded.runId, [seeded.approvalId], "run.cancelled");
    await expectClosed(seeded);
  });

  it("several pending approvals: one event per closed approval, all before the terminal event", async () => {
    downstream.length = 0;
    const seeded = await seedWaiting();
    const second = await addPendingCall(seeded.runId, seeded.threadId, 2);
    await finalize((await repos.getRun(seeded.runId))!, "failed", null, "SYS-9001", "boom");
    await expectResolvedBeforeTerminal(seeded.runId, [seeded.approvalId, second.approvalId], "run.failed");
    await expectClosed(seeded);
    await expectClosed({ runId: seeded.runId, ...second });
  });

  it("failed (finalize failed): closed", async () => {
    downstream.length = 0;
    const seeded = await seedWaiting();
    await finalize((await repos.getRun(seeded.runId))!, "failed", null, "SYS-9001", "boom");
    expect(await runStatus(seeded.runId)).toBe("failed");
    await expectResolvedBeforeTerminal(seeded.runId, [seeded.approvalId], "run.failed");
    await expectClosed(seeded);
  });

  it("succeeded (finalize succeeded): closed", async () => {
    downstream.length = 0;
    const seeded = await seedWaiting();
    await finalize((await repos.getRun(seeded.runId))!, "succeeded", { text: "done" });
    expect(await runStatus(seeded.runId)).toBe("succeeded");
    await expectResolvedBeforeTerminal(seeded.runId, [seeded.approvalId], "run.completed");
    await expectClosed(seeded);
  });

  it("failed APR-2102 (approval expired beyond grace): the overdue one rejected, the other still pending one closed", async () => {
    downstream.length = 0;
    const seeded = await seedWaiting();
    const other = await addPendingCall(seeded.runId, seeded.threadId, 2);
    await execute("UPDATE approvals SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) WHERE id = ?", [seeded.approvalId]);
    const workerId = `w-sweep-${suffix}`;
    const claimed = await claimRun(seeded.runId, workerId, true);
    expect(claimed).not.toBeNull();
    await runClaimed(claimed!, workerId);
    expect((await one<{ status: string; error_code: string | null }>("SELECT status, error_code FROM runs WHERE id = ?", [seeded.runId]))).toMatchObject({ status: "failed", error_code: "APR-2102" });
    expect(await approvalStatus(seeded.approvalId)).toBe("rejected");
    // Only the closed one gets decision "expired"; the overdue (rejected) one is not reported as expired.
    await expectResolvedBeforeTerminal(seeded.runId, [other.approvalId], "run.failed");
    await expectClosed({ runId: seeded.runId, ...other });
  });

  it("same transaction: when the Run's status write is dropped (lease lost), its approvals stay pending", async () => {
    const seeded = await seedWaiting("running", `w-holder-${suffix}`);
    const run = (await repos.getRun(seeded.runId))!;
    await expect(withRunLease(seeded.runId, `w-not-holder-${suffix}`, () => finalize(run, "failed", null, "SYS-9001", "x"))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await runStatus(seeded.runId)).toBe("running");
    expect(await approvalStatus(seeded.approvalId)).toBe("pending");
    expect(await runEvents(seeded.runId)).toEqual([]); // rolled back: no approval.resolved, no terminal event
    // The holder finalizes: both change together, then the event and the terminal event.
    await withRunLease(seeded.runId, `w-holder-${suffix}`, () => finalize(run, "failed", null, "SYS-9001", "x"));
    expect(await runStatus(seeded.runId)).toBe("failed");
    expect(await approvalStatus(seeded.approvalId)).toBe("expired");
    await expectResolvedBeforeTerminal(seeded.runId, [seeded.approvalId], "run.failed");
  });

  it("decided approvals are not touched (approved / rejected keep their status and decided_at)", async () => {
    const seeded = await seedWaiting();
    await execute("UPDATE approvals SET status = 'rejected', decided_at = '2026-01-01 00:00:00.000' WHERE id = ?", [seeded.approvalId]);
    await finalize((await repos.getRun(seeded.runId))!, "cancelled");
    const row = await one<{ status: string; decided_at: Date }>("SELECT status, decided_at FROM approvals WHERE id = ?", [seeded.approvalId]);
    expect(row?.status).toBe("rejected");
    expect(new Date(row!.decided_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(await resolvedEvents(seeded.runId)).toEqual([]); // nothing was closed: no event
    await expectResolvedBeforeTerminal(seeded.runId, [], "run.cancelled");
  });
});
