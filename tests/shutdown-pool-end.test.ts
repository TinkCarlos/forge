import { afterAll, describe, expect, it } from "vitest";
import { startApiProcess, type ApiProcess } from "./helpers/sse-client.js";

// r6 pool-end-cap (real API child process): the database stops answering, so pool.end() never resolves (test preload
// tests/helpers/preload-pending-pool-end.mjs: end() returns a promise that never settles and holds no handle).
// pool.end gets the 1000 ms close slice of the 9000 ms shutdown deadline; then phase pool_end_timeout, the normal
// logger flush, and exit (the last phase line) with code 1. Free non-reserved ports; *_test DB only.
const children: ApiProcess[] = [];
afterAll(() => {
  for (const proc of children) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
});

interface Phase { phase: string; phaseSeq: number; ms: number; code?: number; poolEndMs?: number }
const jsonPhases = (text: string): Phase[] =>
  text.split("\n").filter((line) => line.startsWith("{") && line.includes('"phase"')).map((line) => JSON.parse(line) as Phase);

describe("pool-end-cap: pool.end() that never resolves is cut at the close slice", () => {
  // RED (r6 pool-end-cap): fails until the fix; the fix commit turns it.fails into it.
  it.fails("pool_end_timeout ~1000 ms after the signal, then flush, exit 1 last, no drain_timeout, gone well before 9000 ms", { timeout: 30_000 }, async () => {
    const proc = await startApiProcess({ LOG_LEVEL: "info" }, { preload: ["pending-pool-end"] });
    children.push(proc);
    const sent = Date.now();
    proc.child.kill("SIGTERM");
    const result = await Promise.race([proc.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))]);
    const output = proc.output().slice(-1500);
    expect(result, output).not.toBeNull();
    const ms = result!.at - sent;
    expect(result!.code, `after ${ms} ms\n${output}`).toBe(1);
    expect(ms, output).toBeLessThan(3000);
    const phases = jsonPhases(proc.stdout());
    const names = phases.map((entry) => entry.phase);
    expect(names, output).not.toContain("drain_timeout");
    expect(names).not.toContain("pool_end");
    expect(names.slice(-3)).toEqual(["stop_runtime", "pool_end_timeout", "exit"]);
    const timeout = phases.find((entry) => entry.phase === "pool_end_timeout")!;
    expect(timeout.poolEndMs).toBe(1000);
    expect(timeout.ms).toBeGreaterThanOrEqual(1000);
    expect(timeout.ms).toBeLessThan(2500);
    expect(phases.at(-1)).toMatchObject({ phase: "exit", code: 1 });
    expect(phases.at(-1)!.phaseSeq).toBe(Math.max(...phases.map((entry) => entry.phaseSeq)));
    // The flush ran normally (it called back): no flush_timeout.
    expect(proc.stderr()).not.toContain("flush_timeout");
  });
});
