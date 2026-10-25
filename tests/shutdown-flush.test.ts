import { afterAll, describe, expect, it } from "vitest";
import { partialRequest, startApiProcess, type ApiProcess, type TestOnlyStartOptions } from "./helpers/sse-client.js";

// SIG-10 (r4 shutdown): after the exit phase line the API flushes its logger and waits for it before exiting. The
// flush has a fixed 2000 ms limit; when it passes, one `flush_timeout` JSON line is written to stderr synchronously
// (not through pino) and the process exits with the code the drain gave (0, or 1 after `drain_timeout`). Everything
// stays inside the 10 s backstop. A logger flush that never calls back is only possible through the test preload
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
const flushTimeoutLines = (stderr: string): Array<Record<string, unknown>> =>
  stderr
    .split("\n")
    .filter((line) => line.includes("flush_timeout"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

// Every phase of a shutdown with nothing to drain, in the order they are logged.
const ALL_PHASES = ["signal", "readyz_not_ready", "listener_closed", "sse_ended", "on_close", "app_close", "stop_runtime", "pool_end", "exit"];

/** exit is the last phase: highest phaseSeq, nothing logged after it; listener_closed / sse_ended are there with count 0. */
function expectExitLastNothingToDrain(phases: Phase[], output: string): void {
  expect(phases.map((entry) => entry.phase), output.slice(-1500)).toEqual(ALL_PHASES);
  const exit = phases.find((entry) => entry.phase === "exit")!;
  expect(exit.phaseSeq).toBe(Math.max(...phases.map((entry) => entry.phaseSeq)));
  expect(phases.at(-1)).toBe(exit);
  expect(phases.find((entry) => entry.phase === "listener_closed")).toMatchObject({ count: 0 });
  expect(phases.find((entry) => entry.phase === "sse_ended")).toMatchObject({ count: 0 });
}

describe("SIG-10: logger flush before exit, with a fixed 2000 ms limit", () => {
  it("SIG-10a: the flush never calls back -> after ~2000 ms one flush_timeout line on stderr, exit with the drain code (0), well before the 10 s backstop", { timeout: 30_000 }, async () => {
    const proc = await api({ preload: ["stuck-flush"] });
    const result = await sigterm(proc, 12_000);
    expect(result.code, proc.output().slice(-800)).toBe(0);
    const phases = jsonPhases(proc.stdout());
    const exit = phases.find((entry) => entry.phase === "exit");
    expect(exit, proc.stdout().slice(-800)).toMatchObject({ code: 0 });
    // The flush starts right after the exit line (its ms counts from the signal).
    const flushToExit = result.ms - exit!.ms;
    expect(flushToExit).toBeGreaterThanOrEqual(1800);
    expect(flushToExit).toBeLessThanOrEqual(3000);
    expect(result.ms).toBeLessThan(5000); // not the 10 s backstop
    const timeouts = flushTimeoutLines(proc.stderr());
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ phase: "flush_timeout", code: 0, timeoutMs: 2000 });
    expect(phases.map((entry) => entry.phase)).not.toContain("drain_timeout");
    expect(proc.output()).not.toContain("timed out");
  });

  it("SIG-10b: the drain times out (a stalled half-sent request) and then the flush never calls back -> exit 1, drain_timeout, flush_timeout, all within 10 s", { timeout: 30_000 }, async () => {
    const proc = await api({ preload: ["stuck-flush"] });
    // Only part of the request headers, then nothing: server.close() waits for it (known limit, plugins/sse-shutdown.ts).
    await partialRequest(proc.port, "/healthz", {});
    const result = await sigterm(proc, 15_000);
    expect(result.code, proc.output().slice(-800)).toBe(1);
    expect(result.ms).toBeLessThan(10_000);
    const phases = jsonPhases(proc.stdout());
    expect(phases.map((entry) => entry.phase)).toContain("drain_timeout");
    const timeouts = flushTimeoutLines(proc.stderr());
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ phase: "flush_timeout", code: 1, timeoutMs: 500 });
  });

  // The child's NODE_ENV: development logs through the pino-pretty transport (its flush(cb) is used as is), test as
  // JSON on the default destination. NODE_ENV unset is the production config, which refuses to start without SSO
  // settings; the runner-side development / test / unset runs are covered by running this file under each.
  for (const nodeEnv of ["development", "test"] as const) {
    it(`SIG-10c (${nodeEnv}): a normal flush -> no flush_timeout, the exit line is on stdout, phaseSeq 1..n in arrival order`, { timeout: 30_000 }, async () => {
      const proc = await api({ nodeEnv });
      const result = await sigterm(proc, 12_000);
      expect(result.code, `signal ${String(result.signal)}\n${proc.output().slice(-1500)}`).toBe(0);
      expect(result.ms).toBeLessThan(2000);
      expect(proc.stderr()).not.toContain("flush_timeout");
      const phases = nodeEnv === "development" ? prettyPhases(proc.stdout()) : jsonPhases(proc.stdout());
      // Regression guard: the exit line always reaches stdout.
      expect(phases.filter((entry) => entry.phase === "exit"), proc.stdout().slice(-1200)).toHaveLength(1);
      expect(phases.map((entry) => entry.phaseSeq)).toEqual(phases.map((_entry, index) => index + 1));
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
      expect(result.code, `signal ${String(result.signal)}\n${proc.output().slice(-1500)}`).toBe(0);
      const phases = nodeEnv === "development" ? prettyPhases(proc.stdout()) : jsonPhases(proc.stdout());
      expectExitLastNothingToDrain(phases, proc.output());
    });
  }
});
