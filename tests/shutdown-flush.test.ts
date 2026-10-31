import { afterAll, describe, expect, it } from "vitest";
import { partialRequest, startApiProcess, type ApiProcess, type TestOnlyStartOptions } from "./helpers/sse-client.js";
import { ALL_PHASES, FAST_EXIT_MS, PARENT_BACKSTOP_MS, expectChildExit, expectParentBackstop, recordTiming, tail } from "./helpers/shutdown-assert.js";

// SIG-10 (r4 shutdown): after the exit phase line the API flushes its logger and waits for it before exiting. The
// flush has a fixed 2000 ms limit; when it passes, one `flush_timeout` JSON line is written to stderr synchronously
// (not through pino) and the process exits with the code the drain gave (0, or 1 after `drain_timeout`). Everything
// stays inside the 10 s backstop.
// r6 A19: the bounds are on the child's own exit_call line (signal -> exit(code), monotonic, after the flush); the
// parent's kill -> exit time is only the 12 s backstop. Lower bounds: configured value - 1. Bounds: a19 MEASURE.md. A logger flush that never calls back is only possible through the test preload
// tests/helpers/preload-stuck-flush.mjs. Real API child processes on free non-reserved ports; *_test DB only.
const children: ApiProcess[] = [];
afterAll(() => {
  for (const proc of children) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
});
async function api(testOnly: TestOnlyStartOptions): Promise<ApiProcess> {
  const proc = await startApiProcess({ LOG_LEVEL: "info" }, testOnly);
  children.push(proc);
  return proc;
}
async function sigterm(proc: ApiProcess, limitMs: number): Promise<{ code: number | null | "timeout"; signal?: string | null; ms: number }> {
  const sent = Date.now();
  proc.child.kill("SIGTERM");
  const result = await Promise.race([proc.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), limitMs))]);
  if (!result) return { code: "timeout", ms: Date.now() - sent };
  return { code: result.code, signal: result.signal, ms: result.at - sent };
}

interface Phase {
  phase: string;
  phaseSeq: number;
  ms: number;
  code?: number;
  count?: number;
}
/** In the order they were logged (phaseSeq), not the order they arrived in. */
const sorted = (phases: Phase[]): Phase[] => [...phases].sort((a, b) => a.phaseSeq - b.phaseSeq);
/** Phase lines from JSON output (NODE_ENV test / unset). */
function jsonPhases(text: string): Phase[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes('"phase"'))
    .map((line) => JSON.parse(line) as Phase);
}
/** Phase lines from pino-pretty output (NODE_ENV development): a "[time] INFO (pid): msg" line, then "    key: value". */
function prettyPhases(text: string): Phase[] {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const phases: Phase[] = [];
  for (const block of plain.split(/\n(?=\[)/)) {
    const phase = /^ {4}phase: "([a-z_]+)"$/m.exec(block)?.[1];
    if (!phase) continue;
    const field = (name: string): number | undefined => {
      const value = new RegExp(`^ {4}${name}: (\\d+)$`, "m").exec(block)?.[1];
      return value === undefined ? undefined : Number(value);
    };
    phases.push({ phase, phaseSeq: field("phaseSeq") ?? Number.NaN, ms: field("ms") ?? Number.NaN, code: field("code"), count: field("count") });
  }
  return phases;
}
const flushTimeoutLines = (stderr: string): Array<{ phaseSeq: number; ms: number; flushMs: number; [key: string]: unknown }> =>
  stderr
    .split("\n")
    .filter((line) => line.includes("flush_timeout"))
    .map((line) => JSON.parse(line) as { phaseSeq: number; ms: number; flushMs: number; [key: string]: unknown });

/** SIG-10a: the 2000 ms flush limit after a fast drain (MEASURE.md). */
const STUCK_FLUSH_EXIT_MS = 2500;
/** SIG-10b: drain deadline 9000 + backstop flush 500, the hard promise of the 10 s grace period (architect ruling). */
const BACKSTOP_EXIT_MS = 9500;

/** exit is the last phase: highest phaseSeq, nothing logged after it; listener_closed / sse_ended are there with count 0. */
function expectExitLastNothingToDrain(phases: Phase[], output: string): void {
  expect(phases.map((entry) => entry.phase), tail(output)).toEqual(ALL_PHASES);
  const exit = phases.find((entry) => entry.phase === "exit")!;
  expect(exit.phaseSeq, tail(output)).toBe(Math.max(...phases.map((entry) => entry.phaseSeq)));
  expect(phases.at(-1), tail(output)).toBe(exit);
  expect(phases.find((entry) => entry.phase === "listener_closed"), tail(output)).toMatchObject({ count: 0 });
  expect(phases.find((entry) => entry.phase === "sse_ended"), tail(output)).toMatchObject({ count: 0 });
}

describe("SIG-10: logger flush before exit, with a fixed 2000 ms limit", () => {
  it("SIG-10a: the flush never calls back -> after ~2000 ms one flush_timeout line on stderr, exit with the drain code (0), well before the 10 s backstop", { timeout: 30_000 }, async () => {
    const proc = await api({ preload: ["stuck-flush"] });
    const result = await sigterm(proc, 12_000);
    const output = proc.output();
    expect(result.code, tail(output)).toBe(0);
    const phases = sorted(jsonPhases(proc.stdout()));
    expect(phases.map((entry) => entry.phase), tail(output)).toEqual(ALL_PHASES); // no drain_timeout
    const exit = phases.at(-1)!;
    expect(exit, tail(output)).toMatchObject({ phase: "exit", code: 0 });
    const timeouts = flushTimeoutLines(proc.stderr());
    expect(timeouts, tail(output)).toHaveLength(1);
    expect(timeouts[0], tail(output)).toMatchObject({ phase: "flush_timeout", code: 0, timeoutMs: 2000 });
    // The flush starts right after the exit line and waits its full 2000 ms limit (child clock, configured - 1).
    expect(timeouts[0]!.flushMs, tail(output)).toBeGreaterThanOrEqual(1999);
    expect(timeouts[0]!.phaseSeq, tail(output)).toBe(exit.phaseSeq + 1);
    const call = expectChildExit(output, { code: 0, maxMs: STUCK_FLUSH_EXIT_MS, minMs: exit.ms + 1999 - 1 });
    expect(call.ms, tail(output)).toBeGreaterThanOrEqual(timeouts[0]!.ms as number);
    recordTiming("SIG-10a", { exitCallMs: call.ms, exitPhaseMs: exit.ms, flushMs: timeouts[0]!.flushMs, parentMs: result.ms });
    expectParentBackstop(result.ms, output);
    expect(output).not.toContain("timed out");
  });

  it("SIG-10b: the drain times out (a stalled half-sent request) and then the flush never calls back -> exit 1, drain_timeout, flush_timeout, all within 10 s", { timeout: 30_000 }, async () => {
    const proc = await api({ preload: ["stuck-flush"] });
    // Only part of the request headers, then nothing: server.close() waits for it (known limit, plugins/sse-shutdown.ts).
    await partialRequest(proc.port, "/healthz", {});
    const result = await sigterm(proc, 15_000);
    const output = proc.output();
    expect(result.code, tail(output)).toBe(1);
    const phases = sorted(jsonPhases(proc.stdout()));
    // The half-sent request keeps server.close() (on_close) open: the backstop cuts in, exit last.
    expect(phases.map((entry) => entry.phase), tail(output)).toEqual(["signal", "readyz_not_ready", "listener_closed", "sse_ended", "drain_timeout", "exit"]);
    const drainTimeout = phases.find((entry) => entry.phase === "drain_timeout")!;
    expect(drainTimeout.ms, tail(output)).toBeGreaterThanOrEqual(9000 - 1);
    expect(phases.at(-1), tail(output)).toMatchObject({ phase: "exit", code: 1 });
    const timeouts = flushTimeoutLines(proc.stderr());
    expect(timeouts, tail(output)).toHaveLength(1);
    // The backstop flush gets what is left before its exit point (at most BACKSTOP_FLUSH_MS = 500) and waits all of it.
    expect(timeouts[0], tail(output)).toMatchObject({ phase: "flush_timeout", code: 1 });
    expect(timeouts[0]!.timeoutMs as number, tail(output)).toBeLessThanOrEqual(500);
    expect(timeouts[0]!.flushMs, tail(output)).toBeGreaterThanOrEqual((timeouts[0]!.timeoutMs as number) - 1);
    // The hard promise: exit(1) at most 9500 ms after the signal on the child's clock, strictly (architect ruling).
    const call = expectChildExit(output, { code: 1, maxMs: BACKSTOP_EXIT_MS });
    recordTiming("SIG-10b", { exitCallMs: call.ms, drainTimeoutMs: drainTimeout.ms, flushMs: timeouts[0]!.flushMs, parentMs: result.ms });
    expect(result.ms, tail(output)).toBeLessThan(PARENT_BACKSTOP_MS);
  });

  // The child's NODE_ENV: development logs through the pino-pretty transport (its flush(cb) is used as is), test as
  // JSON on the default destination. NODE_ENV unset is the production config, which refuses to start without SSO
  // settings; the runner-side development / test / unset runs are covered by running this file under each.
  for (const nodeEnv of ["development", "test"] as const) {
    it(`SIG-10c (${nodeEnv}): a normal flush -> no flush_timeout, the exit line is on stdout, phaseSeq 1..n in arrival order`, { timeout: 30_000 }, async () => {
      const proc = await api({ nodeEnv });
      const result = await sigterm(proc, 12_000);
      expect(result.code, `signal ${String(result.signal)}\n${tail(proc.output())}`).toBe(0);
      const call = expectChildExit(proc.output(), { code: 0, maxMs: FAST_EXIT_MS });
      recordTiming(`SIG-10c ${nodeEnv}`, { exitCallMs: call.ms, parentMs: result.ms });
      expectParentBackstop(result.ms, proc.output());
      expect(proc.stderr(), tail(proc.output())).not.toContain("flush_timeout");
      const phases = nodeEnv === "development" ? prettyPhases(proc.stdout()) : jsonPhases(proc.stdout());
      // Regression guard: the exit line always reaches stdout.
      expect(phases.filter((entry) => entry.phase === "exit"), tail(proc.stdout())).toHaveLength(1);
      expect(phases.map((entry) => entry.phaseSeq), tail(proc.stdout())).toEqual(phases.map((_entry, index) => index + 1));
      expectExitLastNothingToDrain(phases, proc.output());
    });
  }
});

describe("SIG-11: exit is the last shutdown phase", () => {
  // No connection at all: plugins/sse-shutdown.ts used to log listener_closed / sse_ended from a setImmediate after
  // preClose, which could run after app.close() and the pool were done, so they came after exit (test) or were lost at
  // process.exit (development).
  for (const nodeEnv of ["test", "development"] as const) {
    it(`SIG-11 (${nodeEnv}): SIGTERM with no connection -> exit has the highest phaseSeq and nothing follows it; listener_closed and sse_ended logged with count 0`, { timeout: 30_000 }, async () => {
      const proc = await api({ nodeEnv });
      const result = await sigterm(proc, 12_000);
      expect(result.code, `signal ${String(result.signal)}\n${tail(proc.output())}`).toBe(0);
      const phases = nodeEnv === "development" ? prettyPhases(proc.stdout()) : jsonPhases(proc.stdout());
      expectExitLastNothingToDrain(phases, proc.output());
      const call = expectChildExit(proc.output(), { code: 0, maxMs: FAST_EXIT_MS });
      recordTiming(`SIG-11 ${nodeEnv}`, { exitCallMs: call.ms, parentMs: result.ms });
      expectParentBackstop(result.ms, proc.output());
    });
  }
});

describe("SIG-12: a pending pool.end() with no handle still ends with an exit line", () => {
  // The drain waits on a promise that holds no handle (test preload: the pool's end() never settles, its sockets are
  // closed). With the backstop timer unref'd the event loop was empty and the process exited 0 with no exit line.
  // r6 pool-end-cap (plan change 10-31 09:28, replaces the r4 expectation drain_timeout at ~9000 ms): pool.end() is cut
  // at the 1000 ms close slice by a timer that is not unref'd either -> pool_end_timeout, flush, exit 1 last.
  it("SIG-12: pool.end() never settles and holds no handle -> pool_end_timeout, exit 1, exit is the last phase line, no drain_timeout, gone within 9.5 s", { timeout: 30_000 }, async () => {
    const proc = await api({ preload: ["pending-pool-end"] });
    const result = await sigterm(proc, 15_000);
    const output = proc.output();
    expect(result.code, `after ${result.ms} ms\n${tail(output)}`).toBe(1);
    const phases = sorted(jsonPhases(proc.stdout()));
    expect(phases.map((entry) => entry.phase), tail(output)).toEqual([...ALL_PHASES.slice(0, -2), "pool_end_timeout", "exit"]);
    expect(phases.find((entry) => entry.phase === "pool_end_timeout")!.ms, tail(output)).toBeGreaterThanOrEqual(1000 - 1);
    expect(phases.at(-1), tail(output)).toMatchObject({ phase: "exit", code: 1 });
    // "gone within 9.5 s": the child's own signal -> exit(1) time; the cut itself is bounded in shutdown-pool-end.
    const call = expectChildExit(output, { code: 1, maxMs: BACKSTOP_EXIT_MS });
    recordTiming("SIG-12", { exitCallMs: call.ms, parentMs: result.ms });
    expectParentBackstop(result.ms, output);
    expect(proc.stderr(), tail(output)).not.toContain("flush_timeout");
  });
});
