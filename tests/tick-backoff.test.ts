import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Pure module (no imports): no database, no config.
import { guardTick, tickBackoffMs, TICK_BACKOFF_MAX_MS } from "../packages/runtime/src/tick-guard";

// K-20 (OPS-010): a rejecting tick must never become an unhandled rejection; consecutive failures back off
// 1s, 2s, 4s, ... capped at 30s; a success resets the backoff.
describe("tickBackoffMs", () => {
  it("grows 1s, 2s, 4s, 8s, 16s then caps at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50, 10_000].map((n) => tickBackoffMs(n))).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(TICK_BACKOFF_MAX_MS).toBe(30_000);
  });
});

describe("guardTick", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  });

  it("a rejecting tick driven by setInterval produces no unhandled rejection and is logged", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const tick = guardTick("schedules", () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" })), { log: (m) => void logs.push(m) });
    const timer = setInterval(() => void tick.run(), 100);
    await vi.advanceTimersByTimeAsync(5_000);
    clearInterval(timer);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let any unhandledRejection event fire
    expect(unhandled).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("[tick:schedules] failed (1 in a row), next attempt in 1000ms: Error ECONNREFUSED: connect ECONNREFUSED");
  });

  it("run() resolves (never rejects) even for synchronous throws", async () => {
    const tick = guardTick("x", () => {
      throw new Error("boom");
    }, { log: () => undefined });
    await expect(tick.run()).resolves.toBe("failed");
  });

  it("skips ticks until the backoff elapses; backoff grows 1s,2s,4s,... capped at 30s", async () => {
    let clock = 0;
    let calls = 0;
    const tick = guardTick("worker", async () => {
      calls += 1;
      throw new Error("db down");
    }, { now: () => clock, log: () => undefined });

    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, delay] of expected.entries()) {
      expect(await tick.run()).toBe("failed");
      expect(calls).toBe(i + 1);
      expect(tick.state().nextAllowedAt - clock).toBe(delay);
      clock += delay - 1;
      expect(await tick.run()).toBe("skipped"); // 1ms before the backoff elapses
      expect(calls).toBe(i + 1);
      clock += 1;
    }
  });

  it("resets the backoff after a success", async () => {
    let clock = 0;
    let fail = true;
    const logs: string[] = [];
    const tick = guardTick("webhook", async () => {
      if (fail) throw new Error("db down");
    }, { now: () => clock, log: (m) => void logs.push(m) });
    await tick.run();
    clock += 1000;
    await tick.run();
    expect(tick.state().consecutiveFailures).toBe(2);
    clock += 2000;
    fail = false;
    expect(await tick.run()).toBe("ran");
    expect(tick.state()).toMatchObject({ consecutiveFailures: 0, nextAllowedAt: 0 });
    expect(logs.at(-1)).toContain("recovered after 2 consecutive failure(s)");
    fail = true;
    await tick.run();
    expect(tick.state().nextAllowedAt - clock).toBe(1000); // starts again at 1s
  });

  it("does not overlap: a tick still running is skipped", async () => {
    let release!: () => void;
    let calls = 0;
    const tick = guardTick("worker", () => {
      calls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    }, { log: () => undefined });
    const first = tick.run();
    expect(await tick.run()).toBe("skipped");
    release();
    expect(await first).toBe("ran");
    expect(calls).toBe(1);
  });

  it("logs only a short summary (no stack / object dump)", async () => {
    const logs: string[] = [];
    const error = new Error("x".repeat(1000));
    const tick = guardTick("t", () => Promise.reject(error), { log: (m) => void logs.push(m) });
    await tick.run();
    expect(logs[0]!.length).toBeLessThan(400);
    expect(logs[0]).not.toContain("at ");
  });
});
