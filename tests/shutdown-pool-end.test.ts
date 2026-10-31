import { afterAll, describe, expect, it } from "vitest";
import { startApiProcess, type ApiProcess } from "./helpers/sse-client.js";
import { ALL_PHASES, expectChildExit, expectParentBackstop, jsonPhases, recordTiming, tail } from "./helpers/shutdown-assert.js";

// r6 pool-end-cap (real API child process): the database stops answering, so pool.end() never resolves (test preload
// tests/helpers/preload-pending-pool-end.mjs: end() returns a promise that never settles and holds no handle).
// pool.end gets the 1000 ms close slice of the 9000 ms shutdown deadline; then phase pool_end_timeout, the normal
// logger flush, and exit (the last phase line) with code 1. Free non-reserved ports; *_test DB only.
// r6 A19: bounds on the child's own clock (phase ms, exit_call); the parent's kill -> exit time only as the 12 s
// backstop. Lower bound: the configured 1000 ms - 1. Upper bounds from a19 MEASURE.md.
/** pool_end_timeout: the 1000 ms cut plus the phases before it (MEASURE.md). */
const POOL_END_TIMEOUT_MAX_MS = 1500;
/** exit(1): the cut plus the normal flush (MEASURE.md). */
const POOL_END_EXIT_MAX_MS = 2000;
const children: ApiProcess[] = [];
afterAll(() => {
  for (const proc of children) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
});


describe("pool-end-cap: pool.end() that never resolves is cut at the close slice", () => {
  it("pool_end_timeout ~1000 ms after the signal, then flush, exit 1 last, no drain_timeout, gone well before 9000 ms", { timeout: 30_000 }, async () => {
    const proc = await startApiProcess({ LOG_LEVEL: "info" }, { preload: ["pending-pool-end"] });
    children.push(proc);
    const sent = Date.now();
    proc.child.kill("SIGTERM");
    const result = await Promise.race([proc.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))]);
    const output = tail(proc.output());
    expect(result, output).not.toBeNull();
    const ms = result!.at - sent;
    expect(result!.code, `after ${ms} ms\n${output}`).toBe(1);
    const phases = jsonPhases(proc.stdout());
    // Order: no pool_end, no drain_timeout, exit last.
    expect(phases.map((entry) => entry.phase), output).toEqual([...ALL_PHASES.slice(0, -2), "pool_end_timeout", "exit"]);
    const timeout = phases.find((entry) => entry.phase === "pool_end_timeout")!;
    expect(timeout.poolEndMs, output).toBe(1000);
    expect(timeout.ms, output).toBeGreaterThanOrEqual(1000 - 1);
    expect(timeout.ms, output).toBeLessThanOrEqual(POOL_END_TIMEOUT_MAX_MS);
    expect(phases.at(-1), output).toMatchObject({ phase: "exit", code: 1 });
    const call = expectChildExit(proc.output(), { code: 1, maxMs: POOL_END_EXIT_MAX_MS, minMs: timeout.ms });
    recordTiming("pool-end-cap", { exitCallMs: call.ms, poolEndTimeoutMs: timeout.ms, parentMs: ms });
    expectParentBackstop(ms, proc.output());
    // The flush ran normally (it called back): no flush_timeout.
    expect(proc.stderr(), output).not.toContain("flush_timeout");
  });
});
