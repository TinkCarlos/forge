import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P3-09 (pure: no DB, no .env). When the heartbeat cannot keep the lease, the worker aborts the execution in hand:
// the AbortSignal reaches the model call and the tool call, and the aborted execution writes nothing (no step result,
// no message, no tool result, no finalize). Policy: the DB answering "not yours" (heartbeat false) aborts at once; a
// heartbeat that errors (DB down) aborts once LEASE_TTL_SECONDS - heartbeat interval has passed since the last
// confirmed renewal (architect ruling 1: before another worker can reclaim the lease); a transient error followed by
// a successful renewal does not abort. Every write of the execution runs inside the lease fence (store withRunLease).
import { ForgeError as StubForgeError } from "../packages/core/src/errors/forge-error.js";
vi.mock("@forge/core", async () => ({
  ForgeError: StubForgeError,
  // Item 7: the pure stored-JSON reader used by the loop for spec_json (no other core dependency).
  storedJsonObject: (await import("../packages/core/src/stored-json")).storedJsonObject,
  config: { LEASE_TTL_SECONDS: 30, MAX_RUN_STEPS: 10, DEFAULT_MAX_COST_USD: 100, DEFAULT_MAX_CONTEXT_TOKENS: 100000, MODEL_MAX_ATTEMPTS: 1, TOOL_MAX_ATTEMPTS: 1, DEFAULT_MAX_PARALLEL_TOOLS: 2 },
  errors: {
    notFound: (m: string) => new StubForgeError("RUN-7001", { message: m, httpStatus: 404, retryable: false }),
    model: (m: string) => new StubForgeError("MDL-3001", { message: m, httpStatus: 502, retryable: false }),
    invalid: (m: string) => new StubForgeError("CFG-8501", { message: m, httpStatus: 400, retryable: false }),
  },
  OUTPUT_REPAIR_PREFIX: "",
}));
const resolveTools = vi.fn();
vi.mock("@forge/capabilities", () => ({ resolveTools }));
const callModel = vi.fn();
vi.mock("@forge/models", () => ({ callModel }));
const RUN = { id: "run_LEASE", thread_id: "thr_LEASE", agent_id: "agt_A", agent_version_id: "ver_A", status: "running", claimed_by: "w1", cost_usd: 0, cancel_requested: 0, output_json: null, usage_json: null };
const repos = {
  getAgent: vi.fn(async () => ({ id: "agt_A" })),
  getAgentVersion: vi.fn(async () => ({ id: "ver_A", instructions: "", spec_json: { model: { provider: "p", model: "m" } } })),
  getRun: vi.fn(async () => ({ ...RUN })),
  timeoutApprovals: vi.fn(async () => undefined),
  listOpenToolCalls: vi.fn(async (): Promise<unknown[]> => []),
  listThreadMessages: vi.fn(async () => []),
  failRunningSteps: vi.fn(async () => 0),
  addRunStep: vi.fn(async () => "stp_1"),
  addRunStepWithSeq: vi.fn(async () => ({ id: "stp_1", seq: 1 })),
  finishRunStep: vi.fn(async () => undefined),
  updateRun: vi.fn(async () => undefined),
  updateToolCall: vi.fn(async () => undefined),
  addToolCall: vi.fn(async () => "tcl_1"),
  heartbeatRun: vi.fn(),
  releaseRunLease: vi.fn(async () => undefined),
};
vi.mock("@forge/store", async () => {
  const fence = await import("../packages/store/src/lease-fence");
  return { parseJsonValue: (v: unknown, d: unknown) => v ?? d, repos, LeaseLostError: fence.LeaseLostError, withRunLease: fence.withRunLease, leaseScope: fence.leaseScope };
});
const appendMessage = vi.fn(async () => "msg_1");
vi.mock("../packages/runtime/src/messages", () => ({ appendMessage, messageOf: (r: unknown) => r }));
const emit = vi.fn(async () => undefined);
vi.mock("../packages/runtime/src/events", () => ({ emit }));
vi.mock("../packages/runtime/src/webhook", () => ({ enqueueRunWebhook: vi.fn(), deliverDueWebhooks: vi.fn() }));
vi.mock("../packages/runtime/src/lease", () => ({ claimRun: vi.fn(), currentWorkerId: () => "w1" }));

const { runClaimed } = await import("../packages/runtime/src/loop");
const { leaseTiming } = await import("../packages/runtime/src/lease-timing");
const { config } = await import("@forge/core");
const { LeaseLostError, leaseScope } = await import("../packages/store/src/lease-fence");

/** A call that only ends when its signal aborts (like a slow upstream). */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
const claimed = () => ({ run: { ...RUN }, previousStatus: "running" }) as never;
const flush = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resolveTools.mockResolvedValue(new Map());
});
afterEach(() => vi.useRealTimers());

function expectNothingWritten() {
  expect(repos.finishRunStep).not.toHaveBeenCalled();
  expect(repos.updateRun).not.toHaveBeenCalled();
  expect(repos.updateToolCall).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: expect.stringMatching(/succeeded|failed/) }));
  expect(appendMessage).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^(run\.(completed|failed)|message\.completed|tool\.(completed|failed))$/), expect.anything());
}

describe("P3-09 heartbeat lease loss aborts the execution", () => {
  it("heartbeat false (lease taken) -> model call signal aborted, nothing written", async () => {
    repos.heartbeatRun.mockResolvedValue(false);
    let signal: AbortSignal | undefined;
    callModel.mockImplementation((input: { signal?: AbortSignal }) => { signal = input.signal; return hangUntilAborted(signal); });
    const done = runClaimed(claimed(), "w1");
    await flush(10_000);
    await done;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expectNothingWritten();
    expect(repos.releaseRunLease).toHaveBeenCalledWith(RUN.id, "w1");
  });

  it("heartbeat erroring (DB down) aborts once TTL - heartbeat interval (30s - 10s) has passed since the last renewal", async () => {
    repos.heartbeatRun.mockRejectedValue(new Error("ECONNREFUSED"));
    let signal: AbortSignal | undefined;
    callModel.mockImplementation((input: { signal?: AbortSignal }) => { signal = input.signal; return hangUntilAborted(signal); });
    const done = runClaimed(claimed(), "w1");
    await flush(19_000);
    expect(signal?.aborted).toBe(false);
    await flush(2_000);
    expect(signal?.aborted).toBe(true);
    await done;
    expect(signal?.aborted).toBe(true);
    expectNothingWritten();
  });

  it("a transient heartbeat error followed by a renewal does not abort", async () => {
    repos.heartbeatRun.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(true);
    let signal: AbortSignal | undefined;
    let finish: (v: unknown) => void = () => undefined;
    callModel.mockImplementation((input: { signal?: AbortSignal }) => { signal = input.signal; return new Promise((r) => { finish = r; }); });
    const done = runClaimed(claimed(), "w1");
    await flush(60_000);
    expect(signal?.aborted).toBe(false);
    finish({ content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    await flush(0);
    await done;
    expect(repos.updateRun).toHaveBeenCalledWith(RUN.id, expect.objectContaining({ status: "succeeded" }));
  });

  it("tool call in progress gets the signal; aborted execution writes no tool result", async () => {
    repos.heartbeatRun.mockResolvedValue(false);
    repos.listOpenToolCalls.mockResolvedValueOnce([{ id: "tcl_1", tool_key: "web_fetch", status: "running", attempt: 1, args_json: {}, risk_level: "medium", read_only: 1 }]);
    let toolSignal: AbortSignal | undefined;
    const execute = vi.fn((_args: unknown, ctx?: { signal?: AbortSignal }) => {
      toolSignal = ctx?.signal;
      return hangUntilAborted(toolSignal).catch(() => ({ ok: false, content: "web_fetch failed: aborted", errorCode: "HTP-4002" }));
    });
    resolveTools.mockResolvedValue(new Map([["web_fetch", { definition: { name: "web_fetch", risk: "medium" }, execute }]]));
    const done = runClaimed(claimed(), "w1");
    await flush(10_000);
    await done;
    expect(toolSignal?.aborted).toBe(true);
    expect(callModel).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe("P3-09 release after a lease loss", () => {
  it("DB still down at release: runClaimed resolves (release is best effort)", async () => {
    repos.heartbeatRun.mockRejectedValue(new Error("ECONNREFUSED"));
    repos.releaseRunLease.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    callModel.mockImplementation((input: { signal?: AbortSignal }) => hangUntilAborted(input.signal));
    const done = runClaimed(claimed(), "w1");
    await flush(30_000);
    await expect(done).resolves.toBeUndefined();
    expectNothingWritten();
  });
});

describe("P3-09 heartbeat tolerance = LEASE_TTL_SECONDS - heartbeat interval (> 0)", () => {
  it("TTL 30s -> heartbeat every 10s, tolerance 20s; TTL 2s -> 1s / 1s", () => {
    expect(leaseTiming(30)).toEqual({ intervalMs: 10_000, toleranceMs: 20_000 });
    expect(leaseTiming(2)).toEqual({ intervalMs: 1_000, toleranceMs: 1_000 });
  });
  it("TTL that leaves no tolerance (1s, heartbeat interval floor 1s) throws naming LEASE_TTL_SECONDS", () => {
    expect(() => leaseTiming(1)).toThrow(/LEASE_TTL_SECONDS/);
  });
  it("runClaimed with such a TTL throws before writing anything; startRuntime fails at startup", async () => {
    const original = config.LEASE_TTL_SECONDS;
    (config as { LEASE_TTL_SECONDS: number }).LEASE_TTL_SECONDS = 1;
    try {
      await expect(runClaimed(claimed(), "w1")).rejects.toThrow(/LEASE_TTL_SECONDS/);
      expect(emit).not.toHaveBeenCalled();
      expect(repos.heartbeatRun).not.toHaveBeenCalled();
      const { startRuntime, stopRuntime } = await import("../packages/runtime/src/worker");
      try {
        expect(() => startRuntime()).toThrow(/LEASE_TTL_SECONDS/);
      } finally {
        stopRuntime();
      }
    } finally {
      (config as { LEASE_TTL_SECONDS: number }).LEASE_TTL_SECONDS = original;
    }
  });
});

describe("P3-09 writes run inside the lease fence", () => {
  it("each write sees the lease scope (this Run, this worker)", async () => {
    repos.heartbeatRun.mockResolvedValue(true);
    const scopes: unknown[] = [];
    repos.addRunStep.mockImplementation(async () => { scopes.push(leaseScope()); return "stp_1"; });
    repos.addRunStepWithSeq.mockImplementation(async () => { scopes.push(leaseScope()); return { id: "stp_1", seq: 1 }; });
    callModel.mockResolvedValue({ content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    await runClaimed(claimed(), "w1");
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope).toEqual({ runId: RUN.id, owner: "w1" });
    expect(leaseScope()).toBeUndefined();
    repos.addRunStep.mockImplementation(async () => "stp_1");
    repos.addRunStepWithSeq.mockImplementation(async () => ({ id: "stp_1", seq: 1 }));
  });

  it("a fenced write rejected (another worker owns the lease) stops the execution: no failed finalize, release still runs", async () => {
    repos.heartbeatRun.mockResolvedValue(true);
    callModel.mockResolvedValue({ content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    repos.updateRun.mockRejectedValueOnce(new LeaseLostError());
    await expect(runClaimed(claimed(), "w1")).resolves.toBeUndefined();
    expect(repos.updateRun).toHaveBeenCalledTimes(1);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^run\.(completed|failed)$/), expect.anything());
    expect(repos.releaseRunLease).toHaveBeenCalledWith(RUN.id, "w1");
  });
});
