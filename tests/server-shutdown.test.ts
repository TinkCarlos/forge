import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    await vi.advanceTimersByTimeAsync(8_000 + 1_499);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(writeStderrSync.mock.calls[0]![0] as string)).toMatchObject({ phase: "flush_timeout", timeoutMs: 1500, code: 0 });
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
