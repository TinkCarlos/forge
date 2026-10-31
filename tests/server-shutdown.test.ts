import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectHandoffMapping } from "./helpers/run-handoff.js";

// P3-07 (pure): SIGTERM / SIGINT -> start the runtime drain (stops claiming at once, r5 §4) -> stop taking requests
// (app.close) -> wait for the drain -> close the DB pool -> exit 0. A failing step is logged and the exit code is
// non-zero (no unhandled rejection); a hard timeout forces exit 1. A drain that ran out of WORKER_DRAIN_TIMEOUT_MS
// logs phase=run_drain_timeout with the Run ids and drainMs and exits 1; the process backstop (timeoutMs) logs
// phase=drain_timeout. A second signal does not start a second shutdown.
const { createShutdown } = await import("../apps/api/src/shutdown.js");

function deps(over: Partial<Record<string, unknown>> = {}) {
  const order: string[] = [];
  const d = {
    close: vi.fn(async () => { order.push("close"); }),
    drainRuntime: vi.fn(async () => { order.push("drain"); return { timedOut: false, runIds: [], ms: 0 }; }),
    closePool: vi.fn(async () => { order.push("closePool"); }),
    exit: vi.fn((code: number) => { order.push(`exit:${code}`); }),
    log: vi.fn(),
    timeoutMs: 10_000,
    ...over,
  };
  return { d, order };
}
/** deps() with a logger flush (default: never calls back) and the synchronous stderr writer, both as typed mocks. */
function flushDeps(over: Partial<Record<string, unknown>> = {}, flush = vi.fn((_done: () => void): void => undefined)) {
  const writeStderrSync = vi.fn((_line: string): void => undefined);
  const { d, order } = deps({ flush, writeStderrSync, ...over });
  return { d, order, flush, writeStderrSync };
}
afterEach(() => vi.useRealTimers());

describe("P3-07 graceful shutdown", () => {
  it("drain (started first) -> close -> closePool -> exit 0", async () => {
    const { d, order } = deps();
    await createShutdown(d as never)("SIGTERM");
    expect(order).toEqual(["drain", "close", "closePool", "exit:0"]);
    expect(d.log).not.toHaveBeenCalled();
  });

  it("app.close throws -> logged, runtime and pool still stopped, exit non-zero, no rejection", async () => {
    const { d, order } = deps({ close: vi.fn(async () => { throw new Error("close failed"); }) });
    await expect(createShutdown(d as never)("SIGTERM")).resolves.toBeUndefined();
    expect(order).toEqual(["drain", "closePool", "exit:1"]);
    expect(d.log).toHaveBeenCalledTimes(1);
  });

  it("pool.end throws -> exit non-zero", async () => {
    const { d, order } = deps({ closePool: vi.fn(async () => { throw new Error("pool"); }) });
    await createShutdown(d as never)("SIGINT");
    expect(order.at(-1)).toBe("exit:1");
  });

  it("the backstop timer is not unref'd (it must hold a drain waiting on a handle-less promise) and is cleared on the normal path", async () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const handles: Array<ReturnType<typeof setTimeout>> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      handle.unref = unref as never;
      handles.push(handle);
      return handle;
    }) as never);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { d } = deps();
      await createShutdown(d as never)("SIGTERM");
      expect(handles.length).toBeGreaterThanOrEqual(1);
      expect(unref).not.toHaveBeenCalled();
      expect(clear).toHaveBeenCalledWith(handles[0]);
      expect(d.exit).toHaveBeenCalledWith(0);
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });

  it("a hung close is cut off by the backstop: drain_timeout, exit 1, before timeoutMs", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const { d } = deps({ close: vi.fn(() => new Promise<void>(() => undefined)), info: vi.fn((_m: string, f: Record<string, unknown>) => lines.push(f.phase as string)) });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    // Backstop at timeoutMs - 1000: room for its 500 ms flush and the process exit inside timeoutMs.
    await vi.advanceTimersByTimeAsync(8_999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual(["signal", "drain_timeout", "exit"]);
    expect(d.log).toHaveBeenCalledWith("shutdown (SIGTERM) timed out after 10000 ms");
    expect(d.exit).toHaveBeenCalledWith(1); // no flush dependency here: exit at once
  });

  it("flush: exit is called only after the logger flush called back (slow flush, fake clock)", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { d, writeStderrSync } = flushDeps(
      { info: vi.fn((_m: string, f: Record<string, unknown>) => events.push(`log:${f.phase as string}`)) },
      vi.fn((done: () => void): void => {
        events.push("flush");
        setTimeout(done, 300);
      }),
    );
    d.exit = vi.fn((code: number) => { events.push(`exit:${code}`); });
    const finished = createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(299);
    expect(events.slice(-2)).toEqual(["log:exit", "flush"]);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)).toBe("exit:0");
    await finished;
    expect(writeStderrSync).not.toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("flush that never calls back: after 2000 ms one flush_timeout JSON line on stderr (sync, not the logger), exit with the drain code", async () => {
    vi.useFakeTimers();
    for (const [over, code] of [[{}, 0], [{ closePool: vi.fn(async () => { throw new Error("pool"); }) }, 1]] as const) {
      const { d, writeStderrSync } = flushDeps(over);
      void createShutdown(d as never)("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(d.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(writeStderrSync).toHaveBeenCalledTimes(1);
      const line = JSON.parse(writeStderrSync.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(line).toMatchObject({ phase: "flush_timeout", timeoutMs: 2000, code });
      expect(d.exit).toHaveBeenCalledWith(code);
      expect(d.exit).toHaveBeenCalledTimes(1);
    }
  });

  it("backstop with a stuck flush: drain_timeout, 500 ms flush, flush_timeout, exit 1, all within timeoutMs", async () => {
    vi.useFakeTimers();
    const { d, flush, writeStderrSync } = flushDeps({ close: vi.fn(() => new Promise<void>(() => undefined)) });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 500, code: 1 });
    expect(d.exit).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("a slow drain shortens the flush limit so the exit stays within timeoutMs; a drain finishing after the backstop does not exit twice", async () => {
    vi.useFakeTimers();
    const { d, writeStderrSync } = flushDeps({ close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 8_000))) });
    void createShutdown(d as never)("SIGTERM");
    // Ruling 15:39: the flush is cut to the 9000 ms deadline (was timeoutMs - EXIT_MARGIN_MS = 9500 in r4).
    await vi.advanceTimersByTimeAsync(8_000 + 999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 1000, code: 0 });
    expect(d.exit).toHaveBeenCalledWith(0);

    const latePhases: string[] = [];
    const late = flushDeps({
      close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 9_200))),
      info: vi.fn((_m: string, f: Record<string, unknown>) => latePhases.push(f.phase as string)),
    });
    void createShutdown(late.d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(late.d.exit).toHaveBeenCalledTimes(1);
    expect(late.d.exit).toHaveBeenCalledWith(1);
    expect(late.writeStderrSync).toHaveBeenCalledTimes(1);
    // exit stays the last phase: the late drain's app_close ... pool_end are not logged after it.
    expect(latePhases).toEqual(["signal", "drain_timeout", "exit"]);
  });

  it("phaseSeq: every phase line carries the next number of one shared counter (strictly increasing, none repeated)", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const { d } = deps({ info: vi.fn((_message: string, fields: Record<string, unknown>) => lines.push(fields)) });
    await createShutdown(d as never)("SIGTERM");
    expect(lines.map((line) => line.phase)).toEqual(["signal", "app_close", "stop_runtime", "pool_end", "exit"]);
    const seqs = lines.map((line) => line.phaseSeq as number);
    expect(seqs.every((seq) => Number.isInteger(seq) && seq >= 1)).toBe(true);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    // The counter is the module in apps/api/src/phase-seq.ts, also used by plugins/sse-shutdown.ts.
    const { nextPhaseSeq } = await import("../apps/api/src/phase-seq.js");
    expect(nextPhaseSeq()).toBe(seqs.at(-1)! + 1);
  });

  it("the pool is closed only after the drain settles (in-flight tool results are stored first)", async () => {
    let finish = () => undefined as void;
    const { d, order } = deps({
      drainRuntime: vi.fn(() => new Promise((resolve) => { finish = () => resolve({ timedOut: false, runIds: [], ms: 5 }); })),
    });
    const done = createShutdown(d as never)("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["close"]);
    finish();
    await done;
    expect(order).toEqual(["close", "closePool", "exit:0"]);
  });

  it("Run drain timed out -> phase run_drain_timeout with runIds and drainMs, normal close continues, exit 1 last", async () => {
    const info = vi.fn();
    const { d, order } = deps({
      info,
      drainRuntime: vi.fn(async () => ({ timedOut: true, runIds: ["r-1", "r-2"], ms: 35_000 })),
    });
    await createShutdown(d as never)("SIGTERM");
    expect(order).toEqual(["close", "closePool", "exit:1"]);
    const phases = info.mock.calls.map(([, fields]) => (fields as { phase: string }).phase);
    expect(phases).toEqual(["signal", "app_close", "run_drain_timeout", "stop_runtime", "pool_end", "exit"]);
    expect(info.mock.calls[2]![1]).toMatchObject({ phase: "run_drain_timeout", runIds: ["r-1", "r-2"], drainMs: 35_000 });
    expect(info.mock.calls.at(-1)![1]).toMatchObject({ phase: "exit", code: 1 });
  });

  it("process backstop (timeoutMs - 1000) logs phase drain_timeout {code:1}, never run_drain_timeout, and exits 1", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const { d } = deps({ info, close: vi.fn(() => new Promise<void>(() => undefined)) });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.exit).toHaveBeenCalledWith(1);
    const phases = info.mock.calls.map(([, fields]) => (fields as { phase: string }).phase);
    expect(phases).toEqual(["signal", "drain_timeout", "exit"]);
    expect(info.mock.calls[1]![1]).toMatchObject({ phase: "drain_timeout", code: 1 });
  });

  it("drainRuntime rejects -> logged, pool still closed, exit 1", async () => {
    const { d, order } = deps({ drainRuntime: vi.fn(async () => { throw new Error("drain"); }) });
    await expect(createShutdown(d as never)("SIGTERM")).resolves.toBeUndefined();
    expect(order).toEqual(["close", "closePool", "exit:1"]);
    expect(d.log).toHaveBeenCalledTimes(1);
  });

  it("a second signal does not run a second shutdown", async () => {
    const { d } = deps();
    const shutdown = createShutdown(d as never);
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM")]);
    expect(d.close).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("server.ts wires it for SIGINT and SIGTERM, with no bare `void` handler", () => {
    const src = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    expect(src).toContain("createShutdown(");
    expect(src).toMatch(/drainRuntime/);
    expect(src).not.toMatch(/stopRuntime/);
    // r4: the process limit stays 10 s (backstop at 9 s), whatever WORKER_DRAIN_TIMEOUT_MS is.
    expect(src).toMatch(/timeoutMs: 10_000,/);
    expect(src).toMatch(/pool\.end\(\)/);
    expect(src).not.toMatch(/=>\s*void\s+shutdown/);
    expect(src).toMatch(/process\.on\("SIGTERM"/);
    expect(src).toMatch(/process\.on\("SIGINT"/);
    // r4: the logger is flushed (log-flush.ts) and a flush timeout is written straight to fd 2, not through pino.
    expect(src).toMatch(/flush: \(done\) => flushLogger\(app\.log, done\)/);
    expect(src).toMatch(/writeSync\(2, /);
  });

  it("the stuck-flush / slow-threadpool test preloads cannot be reached from the production code", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = new URL("../apps/api/src/", import.meta.url);
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) {
      const src = readFileSync(new URL(name, dir), "utf8");
      expect(src, name).not.toMatch(/stuck-flush|slow-threadpool|preload-|UV_THREADPOOL_SIZE|tests\/helpers/);
    }
  });

  it("the standalone worker drains, logs run_drain_timeout, closes the pool and exits 1 on timeout; its hard stop is drain_timeout", () => {
    const src = readFileSync(new URL("../apps/worker/src/main.ts", import.meta.url), "utf8");
    expect(src).toMatch(/drainRuntime\(/);
    expect(src).not.toMatch(/stopRuntime/);
    expect(src).toMatch(/phase: "run_drain_timeout", signal, runIds: result\.runIds, drainMs: result\.ms/);
    // Hard stop at drain + 5 s (process-level backstop): phase drain_timeout, exit 1. No other name for it.
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*console\.error\(JSON\.stringify\(\{ phase: "drain_timeout", signal, code: 1, ms: config\.WORKER_DRAIN_TIMEOUT_MS \+ 5000 \}\)\);\s*process\.exit\(1\);/);
    expect(src).not.toContain("hard_stop");
    expect(src).toMatch(/pool\.end\(\)/);
    expect(src).toMatch(/WORKER_DRAIN_TIMEOUT_MS \+ 5_?000/);
    expect(src).toMatch(/if \(result\.timedOut\) \{\s*code = 1;/);
    expect(src).toMatch(/process\.exit\(code\)/);
  });
});

// Ruling 15:39: one deadline, 9000 ms from the signal. Each step waits min(its own cap, time left): Run drain
// min(WORKER_DRAIN_TIMEOUT_MS, 5000) (then run_drain_timeout), lease release 1000, flush 2000. One run_handoff line per
// Run after run_drain_timeout and before exit.
describe("shutdown deadline budget (ruling 15:39)", () => {
  type Budget = { drainMs: number; releaseMs: number; deadlineAt: number };
  it("the drain gets min(WORKER_DRAIN_TIMEOUT_MS, 5000) and the release 1000, against a deadline 9000 ms after the signal", async () => {
    for (const [configured, expected] of [[35_000, 5000], [1500, 1500], [0, 0]] as const) {
      const seen: Budget[] = [];
      const { d } = deps({ runDrainTimeoutMs: configured, drainRuntime: vi.fn(async (budget: Budget) => { seen.push(budget); return { timedOut: false, runIds: [], ms: 0, handoffs: [] }; }) });
      const before = Date.now();
      await createShutdown(d as never)("SIGTERM");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.drainMs).toBe(expected);
      expect(seen[0]!.releaseMs).toBe(1000);
      expect(seen[0]!.deadlineAt).toBeGreaterThanOrEqual(before + 9000);
      expect(seen[0]!.deadlineAt).toBeLessThanOrEqual(Date.now() + 9000);
    }
  });

  it("run_handoff lines: one per Run, after run_drain_timeout (and release_timeout), before exit; fields as told to ops", async () => {
    const info = vi.fn();
    const handoffs = [
      { runId: "r-1", takeover: "released", reason: "drained" },
      { runId: "r-2", takeover: "lease_expiry", reason: "tool_inflight" },
      { runId: "r-3", takeover: "lease_expiry", reason: "release_timeout" },
    ];
    const { d } = deps({ info, runDrainTimeoutMs: 35_000, drainRuntime: vi.fn(async () => ({ timedOut: true, runIds: ["r-2", "r-3"], ms: 5000, handoffs, releaseTimedOut: true, releaseMs: 1000 })) });
    await createShutdown(d as never)("SIGTERM");
    const lines = info.mock.calls.map(([, fields]) => fields as Record<string, unknown>);
    expect(lines.map((line) => line.phase)).toEqual(["signal", "app_close", "run_drain_timeout", "release_timeout", "run_handoff", "run_handoff", "run_handoff", "stop_runtime", "pool_end", "exit"]);
    expect(lines.find((line) => line.phase === "release_timeout")).toMatchObject({ runIds: ["r-3"], releaseMs: 1000 });
    const handoffLines = lines.filter((line) => line.phase === "run_handoff");
    expect(handoffLines.map(({ phase, runId, takeover, reason }) => ({ phase, runId, takeover, reason }))).toEqual(handoffs.map((h) => ({ phase: "run_handoff", ...h })));
    expectHandoffMapping(handoffLines as never);
    expect(lines.at(-1)).toMatchObject({ phase: "exit", code: 1 });
  });

  it("drained Runs only: run_handoff released/drained, no run_drain_timeout, exit 0", async () => {
    const info = vi.fn();
    const { d } = deps({ info, drainRuntime: vi.fn(async () => ({ timedOut: false, runIds: [], ms: 30, handoffs: [{ runId: "r-9", takeover: "released", reason: "drained" }], releaseTimedOut: false, releaseMs: 5 })) });
    await createShutdown(d as never)("SIGTERM");
    const lines = info.mock.calls.map(([, fields]) => fields as Record<string, unknown>);
    expect(lines.map((line) => line.phase)).toEqual(["signal", "app_close", "run_handoff", "stop_runtime", "pool_end", "exit"]);
    expect(lines.at(-1)).toMatchObject({ phase: "exit", code: 0 });
  });

  it("worst case (drain, release and flush all hang): exit at ~8000 ms with code 1, before 9000, no drain_timeout, exit last", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    // A drain that uses its whole budget: drainMs then releaseMs (what drainRuns does when both steps hang).
    const drainRuntime = vi.fn((budget: Budget) => new Promise((resolve) => setTimeout(() => resolve({
      timedOut: true, runIds: ["r-1"], ms: budget.drainMs, releaseTimedOut: true, releaseMs: budget.releaseMs,
      handoffs: [{ runId: "r-1", takeover: "lease_expiry", reason: "tool_inflight" }],
    }), budget.drainMs + budget.releaseMs)));
    const { d, writeStderrSync } = flushDeps({ info, runDrainTimeoutMs: 35_000, drainRuntime });
    void createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(7_999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.exit).toHaveBeenCalledTimes(1);
    const phases = info.mock.calls.map(([, fields]) => (fields as { phase: string }).phase);
    expect(phases).not.toContain("drain_timeout");
    expect(phases.at(-1)).toBe("exit");
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 2000, code: 1 });
  });

  it("the flush gets min(2000, time left before the 9000 ms deadline)", async () => {
    vi.useFakeTimers();
    const { d, writeStderrSync } = flushDeps({ close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 8_000))) });
    void createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(8_999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 1000, code: 0 });
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  // r6 pool-end-cap: a database that does not answer any more can leave pool.end() pending for good (mysql2 waits for
  // the in-flight queries). pool.end gets the 1000 ms close slice of the 9000 ms deadline (less when the flush would
  // not fit any more); when it runs out: phase pool_end_timeout, then the normal flush, then exit (last), code 1.
  it("pool.end() never resolves: pool_end_timeout {poolEndMs: 1000} after 1000 ms, then the flush, exit 1 last, no drain_timeout", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const flushed: number[] = [];
    const flush = vi.fn((done: () => void): void => { flushed.push(Date.now()); done(); });
    const { d, writeStderrSync } = flushDeps({ info, closePool: vi.fn(() => new Promise<void>(() => undefined)) }, flush);
    const startedAt = Date.now();
    void createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(flushed).toEqual([startedAt + 1000]);
    const lines = info.mock.calls.map(([, fields]) => fields as Record<string, unknown>);
    expect(lines.map((line) => line.phase)).toEqual(["signal", "app_close", "stop_runtime", "pool_end_timeout", "exit"]);
    expect(lines.find((line) => line.phase === "pool_end_timeout")).toMatchObject({ poolEndMs: 1000, ms: 1000 });
    expect(lines.at(-1)).toMatchObject({ phase: "exit", code: 1 });
    expect(writeStderrSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.exit).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => line.phase)).not.toContain("drain_timeout");
  });

  it("worst case with pool.end() hanging too: drain 5000 + release 1000 + pool.end 1000 + flush 2000, exit 1 by the 9000 ms deadline, no drain_timeout", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const drainRuntime = vi.fn((budget: Budget) => new Promise((resolve) => setTimeout(() => resolve({
      timedOut: true, runIds: ["r-1"], ms: budget.drainMs, releaseTimedOut: true, releaseMs: budget.releaseMs,
      handoffs: [{ runId: "r-1", takeover: "lease_expiry", reason: "tool_inflight" }],
    }), budget.drainMs + budget.releaseMs)));
    const { d, writeStderrSync } = flushDeps({ info, runDrainTimeoutMs: 35_000, drainRuntime, closePool: vi.fn(() => new Promise<void>(() => undefined)) });
    void createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(8_999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.exit).toHaveBeenCalledTimes(1);
    const lines = info.mock.calls.map(([, fields]) => fields as Record<string, unknown>);
    expect(lines.map((line) => line.phase)).toEqual(["signal", "app_close", "run_drain_timeout", "run_handoff", "stop_runtime", "pool_end_timeout", "exit"]);
    expect(lines.find((line) => line.phase === "pool_end_timeout")).toMatchObject({ poolEndMs: 1000, ms: 7000 });
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 2000, code: 1 });
  });

  it("pool.end() gets only what is left before the deadline minus the flush: a slow close leaves it 0 ms", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const flush = vi.fn((done: () => void): void => done());
    const { d } = flushDeps({ info, close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 7_500))), closePool: vi.fn(() => new Promise<void>(() => undefined)) }, flush);
    void createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(7_500);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    const lines = info.mock.calls.map(([, fields]) => fields as Record<string, unknown>);
    expect(lines.find((line) => line.phase === "pool_end_timeout")).toMatchObject({ poolEndMs: 0 });
    expect(lines.at(-1)).toMatchObject({ phase: "exit", code: 1 });
  });

  it("server.ts passes WORKER_DRAIN_TIMEOUT_MS and the budget through to drainRuntime", () => {
    const src = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/runDrainTimeoutMs: config\.WORKER_DRAIN_TIMEOUT_MS/);
    expect(src).toMatch(/drainRuntime: \(budget\) => drainRuntime\(budget\.drainMs, budget\)/);
  });

  it("the standalone worker logs one run_handoff line per Run after run_drain_timeout, before it exits", () => {
    const src = readFileSync(new URL("../apps/worker/src/main.ts", import.meta.url), "utf8");
    expect(src).toMatch(/phase: "run_handoff", signal, runId: handoff\.runId, takeover: handoff\.takeover, reason: handoff\.reason/);
    expect(src.indexOf('"run_drain_timeout"')).toBeLessThan(src.indexOf('"run_handoff"'));
    expect(src.indexOf('"run_handoff"')).toBeLessThan(src.lastIndexOf("process.exit(code)"));
  });
});

// r6 A19: the child-process tests bound the time from the signal to the exit(code) call as the child measures it,
// not the parent's wall clock (which also counts spawning, signal delivery and reaping under load). That number has
// to be trustworthy: a monotonic clock (performance.now, not moved when the wall clock is stepped), counted from the
// signal handler to right before exit(code), after the logger flush. It is reported by one JSON line written
// synchronously (reportExit, stderr in server.ts) {event: "exit_call", ms, code}; it is not a phase line, so exit stays
// the last phase.
describe("A19: time from the signal to exit(code), on a monotonic clock", () => {
  type Fields = Record<string, unknown>;
  it("a wall-clock step back during the shutdown changes neither the phase ms nor the exit report", async () => {
    vi.useFakeTimers();
    const fields: Fields[] = [];
    const reportExit = vi.fn((_line: string): void => undefined);
    const { d } = deps({ reportExit, info: vi.fn((_m: string, f: Fields) => fields.push(f)), close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 300))) });
    const finished = createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() - 60_000); // the wall clock is stepped back a minute (NTP), performance.now is not
    await vi.advanceTimersByTimeAsync(200);
    await finished;
    expect(fields.find((entry) => entry.phase === "exit"), JSON.stringify(fields)).toMatchObject({ ms: 300, code: 0 });
    expect(reportExit, JSON.stringify(fields)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(reportExit.mock.calls[0]![0])).toMatchObject({ event: "exit_call", ms: 300, code: 0 });
  });

  it("exit report: written right before exit(code), after the flush called back; ms counts the flush too; not a phase line", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { d } = flushDeps(
      { reportExit: vi.fn((line: string) => { events.push(line); }) },
      vi.fn((done: () => void): void => { setTimeout(done, 700); }),
    );
    d.exit = vi.fn((code: number) => { events.push(`exit:${code}`); });
    const finished = createShutdown(d as never)("SIGTERM");
    await vi.advanceTimersByTimeAsync(700);
    await finished;
    expect(events, JSON.stringify(events)).toHaveLength(2);
    expect(events[1]).toBe("exit:0");
    const line = JSON.parse(events[0]!) as Fields;
    expect(line).toMatchObject({ event: "exit_call", ms: 700, code: 0 });
    expect(line).not.toHaveProperty("phase");
  });

  it("exit report on the backstop path with a stuck flush: code 1 at 9000 + 500 ms, once", async () => {
    vi.useFakeTimers();
    const reportExit = vi.fn((_line: string): void => undefined);
    const { d } = flushDeps({ reportExit, close: vi.fn(() => new Promise<void>(() => undefined)) });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9_500);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(reportExit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(reportExit.mock.calls[0]![0])).toMatchObject({ event: "exit_call", ms: 9500, code: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reportExit).toHaveBeenCalledTimes(1);
  });

  // The backstop's exit is bounded on an absolute point (timeoutMs - EXIT_MARGIN_MS - a timer slack), not drain
  // deadline + 500: measured on Node 22 every timer fires 1-2 ms late, so the drain timer and the flush timer added up
  // to exit(1) at 9503-9504 ms (a19/measure/sig10b-pre-*.log), over the 9500 ms of the grace period's promise.
  it.fails("a backstop that fires late shortens its flush: exit(1) still at 9490 ms (timeoutMs - 500 - 10 slack)", async () => {
    vi.useFakeTimers();
    const realNow = performance.now.bind(performance);
    let lateMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + lateMs);
    const reportExit = vi.fn((_line: string): void => undefined);
    const { d, writeStderrSync } = flushDeps({
      reportExit,
      close: vi.fn(() => new Promise<void>(() => undefined)),
      // The backstop timer fired 3 ms late: everything measured from here on is 3 ms further from the signal.
      log: vi.fn(() => {
        lateMs = 3;
      }),
    });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(d.log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(486);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeStderrSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 487, code: 1 });
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(reportExit.mock.calls[0]![0])).toMatchObject({ event: "exit_call", ms: 9490, code: 1 });
    vi.restoreAllMocks();
  });
});
