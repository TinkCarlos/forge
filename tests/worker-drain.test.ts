import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

// r5 §4 graceful drain (DR-01..05, in process; needs a *_test DB). drainRuntime stops claiming, aborts model calls at
// once, lets tool calls finish and store their result, writes run.released {reason:"drain"} inside the lease fence and
// releases the lease so another worker takes over within one poll. After WORKER_DRAIN_TIMEOUT_MS the rest is aborted
// (rows stay running) and the result says timedOut. Only the network edge is stubbed (model at llm.invalid, downstream).
type Gate = { started: Promise<void>; markStarted: () => void; released: Promise<void>; release: () => void };
function gate(): Gate {
  const g = {} as Gate;
  g.started = new Promise<void>((resolve) => { g.markStarted = resolve; });
  g.released = new Promise<void>((resolve) => { g.release = resolve; });
  return g;
}
let downstreamGate: Gate | null = null;
let modelGate: Gate | null = null;
let downstreamCalls = 0;
const modelReplies: Array<() => Response> = [];
let modelCalls = 0;
function abortable(wait: Promise<void>, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    void wait.then(resolve);
  });
}
const safeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  if (target.hostname === "llm.invalid") {
    modelCalls += 1;
    const held = modelGate;
    modelGate = null;
    if (held) {
      held.markStarted();
      await abortable(held.released, init?.signal);
    }
    const next = modelReplies.shift();
    return next ? next() : reply({ content: "done (default)" });
  }
  downstreamCalls += 1;
  const held = downstreamGate;
  downstreamGate = null;
  if (held) {
    held.markStarted();
    await abortable(held.released, init?.signal);
  }
  return new Response("downstream ok", { status: 200 });
});
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch,
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));

const { execute, one, query, repos } = await import("@forge/store");
const { claimRun, executeRun, runClaimed, drainRuntime } = await import("@forge/runtime");
const { claimRuns } = await import("../packages/runtime/src/worker.js");
const { resetDrain } = await import("../packages/runtime/src/drain.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `dr-${suffix}`;
const SOURCE_KEY = `dr-${suffix}`;
const WRITE = `openapi_${SOURCE_KEY}_write`.replace(/[^a-zA-Z0-9_-]/g, "_");
let agentId = "";
let versionId = "";
let providerId = "";
let sourceId = "";

type Call = { id?: string; type: "function"; function: { name: string; arguments: string } };
function reply(message: { content?: string; tool_calls?: Call[] }): Response {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
}
const call = (name: string, args: Record<string, unknown> = {}): Call => ({ type: "function", function: { name, arguments: JSON.stringify(args) } });
const runRow = async (runId: string) => (await one<{ status: string; claimed_by: string | null }>("SELECT status, claimed_by FROM runs WHERE id = ?", [runId]))!;
const toolRows = (runId: string) => query<{ id: string; status: string; attempt: number }>("SELECT id, status, attempt FROM tool_calls WHERE run_id = ? ORDER BY created_at, step_index, id", [runId]);
const steps = (runId: string) => query<{ type: string; status: string; error_code: string | null }>("SELECT type, status, error_code FROM run_steps WHERE run_id = ? AND type = 'call_model' ORDER BY seq", [runId]);
async function events(runId: string, type: string): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{ data_json: unknown }>("SELECT data_json FROM run_events WHERE run_id = ? AND type = ? ORDER BY seq", [runId, type]);
  return rows.map((row) => (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json) as Record<string, unknown>);
}
async function newRun(): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  return repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status: "queued" });
}
/** Starts the Run on worker `w1`; the run promise is boxed so `await start()` does not wait for the Run itself. */
async function start(runId: string): Promise<{ done: Promise<void> }> {
  const claimed = await claimRun(runId, `w1-${suffix}`, false);
  expect(claimed).not.toBeNull();
  return { done: runClaimed(claimed!, `w1-${suffix}`) };
}
const reset = () => {
  downstreamGate = null;
  modelGate = null;
  downstreamCalls = 0;
  modelReplies.length = 0;
  modelCalls = 0;
};

beforeAll(async () => {
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "DR stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  sourceId = await repos.createToolSource({ key: SOURCE_KEY, name: "dr", baseUrl: "https://down.invalid", spec: { paths: {} } });
  await repos.replaceTools(sourceId, [{ name: "write", operationId: "write", method: "POST", path: "/w", readOnly: false, risk: "low" }]);
  agentId = await repos.createAgent({ key: `it-dr-${suffix}`, name: "IT DR", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "x",
    spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [{ openapi: SOURCE_KEY }] },
    status: "published",
    createdBy: ADMIN_ID,
  });
});
afterEach(() => resetDrain());
afterAll(async () => {
  if (agentId) {
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
});

describe("graceful drain", () => {
  it("DR-01 a tool call in flight finishes and stores its result; run.released {reason:drain}; lease released; another worker continues", async () => {
    reset();
    const runId = await newRun();
    modelReplies.push(() => reply({ content: "", tool_calls: [call(WRITE, { v: 1 })] }));
    downstreamGate = gate();
    const held = downstreamGate!;
    const { done: running } = await start(runId);
    await held.started;
    const drained = drainRuntime(5000);
    held.release();
    await expect(drained).resolves.toMatchObject({ timedOut: false, runIds: [] });
    await running;
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
    expect(modelCalls).toBe(1); // no model step after the tool call: the drained loop returned
    expect(await runRow(runId)).toEqual({ status: "running", claimed_by: null });
    expect(await events(runId, "run.released")).toEqual([{ reason: "drain" }]);
    resetDrain();
    modelReplies.push(() => reply({ content: "done" }));
    await executeRun(runId, `w2-${suffix}`);
    expect(await runRow(runId)).toEqual({ status: "succeeded", claimed_by: null });
    expect(downstreamCalls).toBe(1);
  });

  it("DR-02 a model call in flight is aborted at once; step left running; lease released; the next owner marks it MDL-3001 and calls again", async () => {
    reset();
    const runId = await newRun();
    modelGate = gate();
    const held = modelGate!;
    const { done: running } = await start(runId);
    await held.started;
    const startedAt = Date.now();
    await expect(drainRuntime(5000)).resolves.toMatchObject({ timedOut: false });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await running;
    expect(await steps(runId)).toEqual([{ type: "call_model", status: "running", error_code: null }]);
    expect(await runRow(runId)).toEqual({ status: "running", claimed_by: null });
    expect(await events(runId, "run.released")).toEqual([{ reason: "drain" }]);
    resetDrain();
    modelReplies.push(() => reply({ content: "done" }));
    await executeRun(runId, `w2-${suffix}`);
    expect(await steps(runId)).toEqual([
      { type: "call_model", status: "failed", error_code: "MDL-3001" },
      { type: "call_model", status: "succeeded", error_code: null },
    ]);
    expect(await runRow(runId)).toMatchObject({ status: "succeeded" });
  });

  it("DR-03 drain timeout: the tool call is aborted, its row stays running, timedOut with the Run id; the next owner asks for confirmation (TK-02)", async () => {
    reset();
    const runId = await newRun();
    modelReplies.push(() => reply({ content: "", tool_calls: [call(WRITE, { v: 1 })] }));
    downstreamGate = gate();
    const held = downstreamGate!;
    const { done: running } = await start(runId);
    await held.started;
    const result = await drainRuntime(200);
    expect(result).toMatchObject({ timedOut: true, runIds: [runId] });
    expect(result.ms).toBeGreaterThanOrEqual(200);
    await running;
    const [row] = await toolRows(runId);
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect(await events(runId, "run.released")).toEqual([]);
    expect((await runRow(runId)).claimed_by).toBeNull();
    resetDrain();
    await executeRun(runId, `w2-${suffix}`);
    expect(await toolRows(runId)).toEqual([expect.objectContaining({ id: row!.id, status: "pending_approval", attempt: 1 })]);
    expect(await events(runId, "tool.interrupted")).toEqual([expect.objectContaining({ toolCallId: row!.id, action: "confirm", attempt: 1 })]);
    expect(downstreamCalls).toBe(1);
  });

  it("DR-04 while draining, queued Runs are not claimed by this process", async () => {
    reset();
    const busy = await newRun();
    modelReplies.push(() => reply({ content: "", tool_calls: [call(WRITE, { v: 1 })] }));
    downstreamGate = gate();
    const held = downstreamGate!;
    const { done: running } = await start(busy);
    await held.started;
    const drained = drainRuntime(5000);
    const queued = await newRun();
    await claimRuns(`w1-${suffix}`);
    expect(await runRow(queued)).toEqual({ status: "queued", claimed_by: null });
    held.release();
    await drained;
    await running;
    await execute("UPDATE runs SET status = 'cancelled' WHERE id IN (?, ?)", [busy, queued]);
  });

  it("DR-05 the lease already belongs to another worker: run.released not written, its lease not cleared, no error", async () => {
    reset();
    const runId = await newRun();
    modelReplies.push(() => reply({ content: "", tool_calls: [call(WRITE, { v: 1 })] }));
    downstreamGate = gate();
    const held = downstreamGate!;
    const { done: running } = await start(runId);
    await held.started;
    await execute("UPDATE runs SET claimed_by = 'dr-other', lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 SECOND) WHERE id = ?", [runId]);
    const drained = drainRuntime(5000);
    held.release();
    await expect(drained).resolves.toMatchObject({ timedOut: false });
    await expect(running).resolves.toBeUndefined();
    expect(await events(runId, "run.released")).toEqual([]);
    expect((await runRow(runId)).claimed_by).toBe("dr-other");
    await execute("UPDATE runs SET status = 'cancelled', claimed_by = NULL WHERE id = ?", [runId]);
  });
});
