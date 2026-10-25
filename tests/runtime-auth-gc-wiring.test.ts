import { afterEach, describe, expect, it, vi } from "vitest";

// startRuntime wiring guard: the auth GC tick (session store, migration 007) is scheduled every AUTH_GC_INTERVAL_MS
// next to the worker poll. Every tick body is a fake, so no real Run is claimed and nothing touches the database.
const fakes = vi.hoisted(() => ({
  collectExpiredAuth: vi.fn(async () => ({ ran: true, sessions: 0, states: 0 })),
  claimNext: vi.fn(async (_workerId: string) => null),
  runClaimed: vi.fn(async () => undefined),
  tickSchedules: vi.fn(async () => undefined),
  deliverDueWebhooks: vi.fn(async () => undefined),
}));

vi.mock("../packages/runtime/src/auth-gc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/runtime/src/auth-gc.js")>()),
  collectExpiredAuth: fakes.collectExpiredAuth,
}));
vi.mock("../packages/runtime/src/lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/runtime/src/lease.js")>()),
  claimNext: fakes.claimNext,
  currentWorkerId: () => "wiring-test-worker",
}));
vi.mock("../packages/runtime/src/loop.js", () => ({ runClaimed: fakes.runClaimed }));
vi.mock("../packages/runtime/src/schedules.js", () => ({ tickSchedules: fakes.tickSchedules }));
vi.mock("../packages/runtime/src/webhook.js", () => ({ deliverDueWebhooks: fakes.deliverDueWebhooks }));

const { startRuntime, stopRuntime } = await import("../packages/runtime/src/worker.js");
const { AUTH_GC_INTERVAL_MS } = await import("../packages/runtime/src/auth-gc.js");

afterEach(() => {
  stopRuntime();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startRuntime wiring", () => {
  it("RT-01: collectExpiredAuth runs once per AUTH_GC_INTERVAL_MS, stops with stopRuntime, and no Run is claimed", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    startRuntime();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.collectExpiredAuth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTH_GC_INTERVAL_MS);
    expect(fakes.collectExpiredAuth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTH_GC_INTERVAL_MS);
    expect(fakes.collectExpiredAuth).toHaveBeenCalledTimes(2);

    // The worker poll ran against the fake runner only: it asked for work, got none, and started nothing.
    expect(fakes.claimNext).toHaveBeenCalled();
    expect(fakes.claimNext.mock.calls.every(([workerId]) => workerId === "wiring-test-worker")).toBe(true);
    expect(fakes.runClaimed).not.toHaveBeenCalled();

    stopRuntime();
    const calls = fakes.collectExpiredAuth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(AUTH_GC_INTERVAL_MS * 2);
    expect(fakes.collectExpiredAuth).toHaveBeenCalledTimes(calls);
  });
});
