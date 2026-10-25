import { describe, expect, it, vi } from "vitest";

// TK-09 (pure, no DB): every worker cycle also sweeps waiting Runs whose approval expired (design §2.3): it lists
// them (oldest expires_at first, at most the free MAX_CONCURRENT_RUNS slots), claims each allowing waiting_approval and
// executes it like any claimed Run, counted against the same concurrency limit.
const listRunsWithExpiredApprovals = vi.fn(async (_limit: number): Promise<string[]> => []);
const claimRun = vi.fn(async (runId: string, _workerId: string, _allowWaiting: boolean) => ({ run: { id: runId }, previousStatus: "waiting_approval" }) as unknown);
const releases: Array<() => void> = [];
const runClaimed = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
vi.mock("@forge/core", () => ({ config: { MAX_CONCURRENT_RUNS: 2, LEASE_TTL_SECONDS: 30, WORKER_POLL_MS: 1000 } }));
vi.mock("@forge/store", () => ({ repos: { listRunsWithExpiredApprovals } }));
vi.mock("../packages/runtime/src/lease", () => ({ claimRun, claimNext: vi.fn(async () => null), currentWorkerId: () => "w1" }));
vi.mock("../packages/runtime/src/loop", () => ({ runClaimed }));
vi.mock("../packages/runtime/src/schedules", () => ({ tickSchedules: vi.fn() }));
vi.mock("../packages/runtime/src/webhook", () => ({ deliverDueWebhooks: vi.fn() }));
vi.mock("../packages/runtime/src/auth-gc", () => ({ AUTH_GC_INTERVAL_MS: 600000, collectExpiredAuth: vi.fn() }));
const { sweepExpiredApprovals } = await import("../packages/runtime/src/worker");

describe("expired-approval sweep (TK-09)", () => {
  it("claims listed Runs with allowWaiting, runs them, and respects MAX_CONCURRENT_RUNS", async () => {
    listRunsWithExpiredApprovals.mockResolvedValueOnce(["run_a", "run_b"]);
    claimRun.mockResolvedValueOnce({ run: { id: "run_a" }, previousStatus: "waiting_approval" }).mockResolvedValueOnce(null);
    await sweepExpiredApprovals("w1");
    expect(listRunsWithExpiredApprovals).toHaveBeenCalledWith(2);
    expect(claimRun.mock.calls).toEqual([["run_a", "w1", true], ["run_b", "w1", true]]);
    expect(runClaimed).toHaveBeenCalledTimes(1);
    expect(runClaimed).toHaveBeenCalledWith({ run: { id: "run_a" }, previousStatus: "waiting_approval" }, "w1");

    // One slot left.
    listRunsWithExpiredApprovals.mockResolvedValueOnce(["run_c"]);
    await sweepExpiredApprovals("w1");
    expect(listRunsWithExpiredApprovals).toHaveBeenLastCalledWith(1);
    expect(runClaimed).toHaveBeenCalledTimes(2);

    // Full: nothing listed.
    await sweepExpiredApprovals("w1");
    expect(listRunsWithExpiredApprovals).toHaveBeenCalledTimes(2);

    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listRunsWithExpiredApprovals.mockResolvedValueOnce([]);
    await sweepExpiredApprovals("w1");
    expect(listRunsWithExpiredApprovals).toHaveBeenLastCalledWith(2);
  });
});
