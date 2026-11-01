import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// r6 decide-cancel-race (architect contract 10:06 / 10:07 / 10:13): POST /admin/api/approvals/:id/decide (approve)
// and POST /admin/api/runs/:id/cancel on the same Run.
// - A cancel of a Run that has not finished is never refused: 200, body unchanged ({ ok: true }). It takes effect once
//   the current tool call has ended (no forced interruption) and the Run ends cancelled.
// - Mutual exclusion only on a still-pending approval: when the cancel is committed first the approve gets 409
//   APR-2104 and the tool runs 0 times; when the approve is committed first the cancel is the post-approval case.
// - A Run whose cancel is committed but not finished (its finish failed) is finished by the worker's cancel sweep with
//   the terminal rules (approval expired, approval.resolved before run.cancelled; nothing if the lease is lost).
// - A finished Run: cancel is still 409 RUN-7005 (DCR-14 / I-RUN-06).
// The decide path starts executeRun in this process (fire-and-forget), so the tool really runs here. Only the model's
// network edge is stubbed (safeFetch: the model answers "done" after the tool result). *_test DB only.
const KEY = vi.hoisted(() => `dcr${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`);
const KEY_LONG = vi.hoisted(() => `dcl${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`);
const HANG_MS = 400;
/** Long enough that the cancel surely lands while the tool executes, even on a loaded machine. */
const LONG_HANG_MS = 1500;
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })),
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));
vi.mock("@forge/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forge/capabilities")>();
  const { hangingTools } = await import("./helpers/hanging-tool.js");
  return {
    ...actual,
    resolveTools: async (spec: Parameters<typeof actual.resolveTools>[0]) => {
      const tools = await actual.resolveTools(spec);
      for (const [name, tool] of hangingTools({ key: KEY, hangMs: HANG_MS, risk: "high" })) tools.set(name, tool);
      for (const [name, tool] of hangingTools({ key: KEY_LONG, hangMs: LONG_HANG_MS, risk: "high" })) tools.set(name, tool);
      return tools;
    },
  };
});

const { execute, one, query, repos } = await import("@forge/store");
const { executeRun } = await import("@forge/runtime");
const runtimeWorker: Record<string, unknown> = await import("../packages/runtime/src/worker.js");
const { sessionCookieValue } = await import("@forge/identity");
const { buildApp } = await import("../apps/api/src/app.js");
const { cleanupRealSessions, realSession, sessionHeaders } = await import("./helpers/real-session.js");
const { cleanupStubEffects, ensureStubEffectsTable, hangingToolNames } = await import("./helpers/hanging-tool.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `dcr-${suffix}`;
const EFFECT = hangingToolNames(KEY).effect;
const EFFECT_LONG = hangingToolNames(KEY_LONG).effect;
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let providerId = "";

type Seeded = { runId: string; rowId: string; approvalId: string; key: string };
async function seedWaiting(tool = EFFECT): Promise<Seeded> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status: "waiting_approval", claimedBy: null, leaseSeconds: null });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: tool } });
  const rowId = await repos.addToolCall({ runId, toolKey: tool, args: {}, risk: "high", status: "pending", idempotencyKey: `${runId}:s1:0`, readOnly: false, modelStep: 1, stepIndex: 0 });
  await repos.addMessage({ threadId, runId, seq: 2, role: "assistant", content: { text: "", tool_calls: [{ id: rowId, type: "function", function: { name: tool, arguments: "{}" } }] } });
  const approval = await repos.addApproval({ runId, toolCallId: rowId, risk: "high", timeoutSeconds: 3600 });
  return { runId, rowId, approvalId: approval.id, key: tool === EFFECT_LONG ? KEY_LONG : KEY };
}
const runStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM runs WHERE id = ?", [id]))!.status;
const TERMINAL = ["succeeded", "failed", "cancelled", "budget_exhausted"];
/** Waits until the Run is terminal and nothing of it is still executing (the stub hangs HANG_MS). */
async function settled(runId: string): Promise<string> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const status = await runStatus(runId);
    const open = await one<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ? AND status = 'running'", [runId]);
    if (TERMINAL.includes(status) && Number(open?.n ?? 0) === 0) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return runStatus(runId);
}
const decide = (id: string) => app.inject({ method: "POST", url: `/admin/api/approvals/${id}/decide`, headers, payload: { decision: "approved" } });
const cancel = (runId: string) => app.inject({ method: "POST", url: `/admin/api/runs/${runId}/cancel`, headers });
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
/** Side effects of this seeded call (the tool gets idempotencyKey sha256(runId:toolCallId), tools.ts toolRequestKey). */
const effectsOf = async (seeded: Seeded) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM test_tool_stub_effects WHERE stub_key = ? AND idempotency_key = ?`, [seeded.key, createHash("sha256").update(`${seeded.runId}:${seeded.rowId}`).digest("hex")]))?.n ?? 0);

const toolCallStatus = async (seeded: Seeded) => (await one<{ status: string }>("SELECT status FROM tool_calls WHERE id = ?", [seeded.rowId]))!.status;
/** Waits until the stub recorded its side effect (it does so when it starts, then hangs). */
async function toolStarted(seeded: Seeded): Promise<boolean> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if ((await effectsOf(seeded)) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

type EventRow = { seq: number; type: string; data_json: unknown };
const eventsOf = (runId: string) => query<EventRow>("SELECT seq, type, data_json FROM run_events WHERE run_id = ? ORDER BY seq", [runId]);
const dataOf = (row: EventRow) => (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json) as Record<string, unknown>;
const approvalStatus = async (seeded: Seeded) => (await one<{ status: string }>("SELECT status FROM approvals WHERE id = ?", [seeded.approvalId]))!.status;
const cancelFlag = async (runId: string) => Number((await one<{ f: number }>("SELECT cancel_requested AS f FROM runs WHERE id = ?", [runId]))!.f);
/**
 * The worker's cancel sweep (r6; missing before the fix: the test fails there). The shared test DB may hold older
 * cancel-requested Runs that come first in a batch, so it sweeps until this Run is finished (at most 10 cycles).
 */
async function cancelSweep(workerId: string, runId: string): Promise<void> {
  const sweep = runtimeWorker.sweepCancelRequestedRuns;
  expect(typeof sweep, "sweepCancelRequestedRuns is not exported by the worker").toBe("function");
  for (let cycle = 0; cycle < 10; cycle += 1) {
    await (sweep as (id: string) => Promise<void>)(workerId);
    if (TERMINAL.includes(await runStatus(runId))) return;
  }
}
/** Spies repos.updateRun for the terminal "cancelled" write of one Run: `before` runs once, then the real write. */
function onCancelledWrite(runId: string, before: () => Promise<void>) {
  const original = repos.updateRun;
  const state = { fired: false };
  const spy = vi.spyOn(repos, "updateRun").mockImplementation(async (id, fields) => {
    if (!state.fired && id === runId && fields.status === "cancelled") {
      state.fired = true;
      await before();
    }
    return original.call(repos, id, fields);
  });
  return { state, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
  await ensureStubEffectsTable();
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "DCR stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  agentId = await repos.createAgent({ key: `it-dcr-${suffix}`, name: "IT DCR", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [] }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
});

afterAll(async () => {
  // Let anything a failing (red) test left executing in this process end before its rows are removed.
  await new Promise((resolve) => setTimeout(resolve, LONG_HANG_MS + 500));
  await cleanupStubEffects(KEY);
  await cleanupStubEffects(KEY_LONG);
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN runs r ON r.id = a.resource_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    for (const table of ["run_events", "run_steps", "messages", "approvals", "tool_calls"]) {
      await execute(`DELETE x FROM ${table} x JOIN runs r ON r.id = x.run_id WHERE r.agent_id = ?`, [agentId]);
    }
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("decide (approve) and cancel on the same Run", () => {
  it("(1) approve, then cancel while the tool executes: 200, the tool call completes once, the Run ends cancelled", { timeout: 30_000 }, async () => {
    const seeded = await seedWaiting(EFFECT_LONG);
    const decided = await decide(seeded.approvalId);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await toolStarted(seeded), "the approved tool never started").toBe(true);
    expect(await toolCallStatus(seeded)).toBe("running");
    const cancelled = await cancel(seeded.runId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true });
    expect(await settled(seeded.runId)).toBe("cancelled");
    expect(await toolCallStatus(seeded)).toBe("succeeded");
    expect(await effectsOf(seeded)).toBe(1);
    // DCR-14: the Run is finished now, so cancel is 409 RUN-7005 (unchanged).
    const again = await cancel(seeded.runId);
    expect(again.statusCode, again.body).toBe(409);
    expect(code(again)).toBe("RUN-7005");
  });

  it("(2) approve and cancel concurrently, cancel wins on the pending approval: approve 409 APR-2104, the tool runs 0 times, the Run is cancelled", { timeout: 30_000 }, async () => {
    const seeded = await seedWaiting();
    // Deterministic interleaving: the approve arrives after the cancel is committed, just before the cancel's terminal
    // write (inside repos.updateRun for status cancelled).
    const injected: { decided?: Awaited<ReturnType<typeof decide>> } = {};
    const hook = onCancelledWrite(seeded.runId, async () => {
      injected.decided = await decide(seeded.approvalId);
    });
    let cancelled: Awaited<ReturnType<typeof cancel>>;
    try {
      cancelled = await cancel(seeded.runId);
    } finally {
      hook.restore();
    }
    expect(hook.state.fired, "the approve was not injected into the cancel").toBe(true);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(injected.decided?.statusCode, injected.decided?.body).toBe(409);
    expect(code(injected.decided!)).toBe("APR-2104");
    expect(await settled(seeded.runId)).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, HANG_MS + 100));
    expect(await effectsOf(seeded)).toBe(0);
    expect(await approvalStatus(seeded)).toBe("expired");
  });

  it("cancel committed first, approve right after: approve 409 APR-2104, the tool never runs, the Run is cancelled", async () => {
    const seeded = await seedWaiting();
    const cancelled = await cancel(seeded.runId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const decided = await decide(seeded.approvalId);
    expect(decided.statusCode, decided.body).toBe(409);
    expect(code(decided)).toBe("APR-2104");
    expect(await settled(seeded.runId)).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, HANG_MS + 100));
    expect(await effectsOf(seeded)).toBe(0);
  });

  it("approved but not claimed yet: cancel 200, the Run is cancelled at once and a late executeRun runs nothing", async () => {
    const seeded = await seedWaiting();
    expect(await repos.decideApproval(seeded.approvalId, "approved", ADMIN_ID, "")).toBe(true);
    const cancelled = await cancel(seeded.runId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await runStatus(seeded.runId)).toBe("cancelled");
    await executeRun(seeded.runId, `w-late-${suffix}`);
    expect(await effectsOf(seeded)).toBe(0);
  });

  it("finish failed after the cancel was committed: cancel still 200, the approve loses, the cancel sweep finishes the Run (approval expired, approval.resolved before run.cancelled)", { timeout: 30_000 }, async () => {
    const seeded = await seedWaiting();
    const hook = onCancelledWrite(seeded.runId, async () => {
      throw new Error("simulated terminal write failure");
    });
    let cancelled: Awaited<ReturnType<typeof cancel>>;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      cancelled = await cancel(seeded.runId);
    } finally {
      hook.restore();
      quiet.mockRestore();
    }
    expect(hook.state.fired).toBe(true);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // Committed but not finished: not terminal, flag set, approval still pending; nobody may execute it.
    expect(await runStatus(seeded.runId)).toBe("waiting_approval");
    expect(await cancelFlag(seeded.runId)).toBe(1);
    expect(await approvalStatus(seeded)).toBe("pending");
    const decided = await decide(seeded.approvalId);
    expect(decided.statusCode, decided.body).toBe(409);
    expect(code(decided)).toBe("APR-2104");
    await executeRun(seeded.runId, `w-late-${suffix}`);
    expect(await effectsOf(seeded)).toBe(0);
    const before = (await eventsOf(seeded.runId)).length;
    await cancelSweep(`w-sweep-${suffix}`, seeded.runId);
    expect(await runStatus(seeded.runId)).toBe("cancelled");
    expect(await approvalStatus(seeded)).toBe("expired");
    const added = (await eventsOf(seeded.runId)).slice(before);
    expect(added.map((row) => row.type)).toEqual(["approval.resolved", "run.cancelled"]);
    expect(dataOf(added[0]!)).toEqual({ approvalId: seeded.approvalId, decision: "expired" });
    expect(await effectsOf(seeded)).toBe(0);
  });

  it("cancel sweep loses the lease before its terminal write: nothing is written or emitted; a later sweep finishes the Run", { timeout: 30_000 }, async () => {
    const seeded = await seedWaiting();
    // A cancel that is committed but not finished (as after a failed finish).
    await execute("UPDATE runs SET cancel_requested = 1 WHERE id = ?", [seeded.runId]);
    const before = (await eventsOf(seeded.runId)).length;
    const hook = onCancelledWrite(seeded.runId, async () => {
      // Another owner takes the lease between the sweep's claim and its fenced terminal write.
      await execute("UPDATE runs SET claimed_by = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ?", [`w-other-${suffix}`, seeded.runId]);
    });
    try {
      await cancelSweep(`w-sweep-${suffix}`, seeded.runId);
    } finally {
      hook.restore();
    }
    expect(hook.state.fired, "the sweep never tried to finish the Run").toBe(true);
    expect(await runStatus(seeded.runId)).toBe("waiting_approval");
    expect(await approvalStatus(seeded)).toBe("pending");
    expect((await eventsOf(seeded.runId)).length).toBe(before);
    // The other owner goes away (its lease expires): the next sweep finishes the Run.
    await execute("UPDATE runs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?", [seeded.runId]);
    await cancelSweep(`w-sweep-${suffix}`, seeded.runId);
    expect(await runStatus(seeded.runId)).toBe("cancelled");
    expect(await approvalStatus(seeded)).toBe("expired");
    expect((await eventsOf(seeded.runId)).slice(before).map((row) => row.type)).toEqual(["approval.resolved", "run.cancelled"]);
  });

  it("(3) concurrent approve and cancel (12 rounds): cancel on the unfinished Run is never refused (200, never 409), the Run always ends cancelled; approve refused (APR-2104) -> tool 0 times, approve accepted -> at most once", { timeout: 120_000 }, async () => {
    for (let round = 0; round < 12; round += 1) {
      // The long hanging tool keeps an approved Run unfinished well past the cancel, so the cancel always meets a Run
      // that has not finished (cancel on a finished Run stays 409 RUN-7005, see (1)).
      const seeded = await seedWaiting(EFFECT_LONG);
      // Alternate which request is sent first so both orders of arrival are covered.
      const [decided, cancelled] = round % 2 === 0
        ? await Promise.all([decide(seeded.approvalId), cancel(seeded.runId)])
        : await Promise.all([cancel(seeded.runId), decide(seeded.approvalId)]).then(([c, d]) => [d, c] as const);
      const label = `round ${round}: decide ${decided.statusCode} ${decided.body} / cancel ${cancelled.statusCode} ${cancelled.body}`;
      expect(cancelled.statusCode, label).toBe(200);
      const status = await settled(seeded.runId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const effects = await effectsOf(seeded);
      expect(status, label).toBe("cancelled");
      if (decided.statusCode === 200) {
        expect(effects, label).toBeLessThanOrEqual(1);
      } else {
        expect(decided.statusCode, label).toBe(409);
        expect(code(decided), label).toBe("APR-2104");
        expect(effects, `${label}: cancel won but the tool ran`).toBe(0);
      }
    }
  });
});
