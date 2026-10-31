import { appendFileSync } from "node:fs";
import { expect } from "vitest";

// r6 A19: timing assertions of the shutdown tests. The contract values are bounded on the time the child measures
// itself (exit_call: signal handler -> right before exit(code), after the logger flush, monotonic clock; see
// apps/api/src/shutdown.ts reportExit), not on the parent's wall clock, which also counts spawning, signal delivery
// and reaping under load. The parent-side time is only a backstop (PARENT_BACKSTOP_MS). Lower bounds are the
// configured value - 1 (a timer can fire 1 ms "early" when measured with Date.now). The phase ORDER is asserted.
// Every assertion carries the child output (or the result object), so a failure can be read afterwards.

/** Parent side: from kill() to the exit event, only a backstop (spawn, signal delivery and reaping included). */
export const PARENT_BACKSTOP_MS = 12_000;

/** Every phase of an API shutdown with nothing left to drain, in phaseSeq order (shutdown.ts + plugins/sse-shutdown.ts). */
export const ALL_PHASES = ["signal", "readyz_not_ready", "listener_closed", "sse_ended", "on_close", "app_close", "stop_runtime", "pool_end", "exit"];

/** "exit 0 within 2 s" of the API child with nothing to drain: bounded on its own exit_call ms (see a19 MEASURE.md). */
export const FAST_EXIT_MS = 2000;

/** The last `chars` characters of a child's output, for assertion messages. */
export const tail = (output: string, chars = 1500): string => output.slice(-chars);

export interface PhaseLine {
  phase: string;
  phaseSeq: number;
  ms: number;
  code?: number;
  [key: string]: unknown;
}

/** JSON phase lines (NODE_ENV test / unset), sorted by phaseSeq (the order they were logged in). */
export function jsonPhases(text: string): PhaseLine[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes('"phase"'))
    .map((line) => JSON.parse(line) as PhaseLine)
    .sort((a, b) => a.phaseSeq - b.phaseSeq);
}

/** The phase names in phaseSeq order equal `expected` exactly. */
export function expectPhaseOrder(phases: PhaseLine[], expected: string[], output: string): void {
  expect(phases.map((entry) => entry.phase), tail(output)).toEqual(expected);
}

export interface ExitCall {
  ms: number;
  code: number;
}

/**
 * The child's exit_call line. Throws (with the output) when it is missing, appears more than once or has no numeric
 * ms: a child that hung, was killed, or exited without reporting must fail the test, never skip the bound.
 */
export function exitCall(output: string): ExitCall {
  const lines = output.split("\n").filter((line) => line.startsWith("{") && line.includes('"event":"exit_call"'));
  if (lines.length !== 1) throw new Error(`expected exactly one exit_call line from the child, got ${lines.length}\n${tail(output)}`);
  const parsed = JSON.parse(lines[0]!) as { ms?: unknown; code?: unknown };
  if (typeof parsed.ms !== "number" || !Number.isFinite(parsed.ms) || typeof parsed.code !== "number") {
    throw new Error(`exit_call line without numeric ms / code: ${lines[0]}\n${tail(output)}`);
  }
  return { ms: parsed.ms, code: parsed.code };
}

/** exit_call: the child called exit(code) at most `maxMs` after the signal (its own monotonic clock). */
export function expectChildExit(output: string, expected: { code: number; maxMs: number; minMs?: number }): ExitCall {
  const call = exitCall(output);
  expect(call.code, tail(output)).toBe(expected.code);
  expect(call.ms, tail(output)).toBeLessThanOrEqual(expected.maxMs);
  if (expected.minMs !== undefined) expect(call.ms, tail(output)).toBeGreaterThanOrEqual(expected.minMs);
  return call;
}

/** Parent-side backstop: the exit event within PARENT_BACKSTOP_MS of the kill(). */
export function expectParentBackstop(parentMs: number, output: string): void {
  expect(parentMs, tail(output)).toBeLessThan(PARENT_BACKSTOP_MS);
}

/**
 * Measurement hook (A19 MEASURE.md, QA load runs): with SHUTDOWN_TIMING_LOG set to a file path, one JSON line per
 * call is appended there. Nothing happens without it.
 */
export function recordTiming(test: string, fields: Record<string, unknown>): void {
  const file = process.env.SHUTDOWN_TIMING_LOG;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ test, at: new Date().toISOString(), ...fields })}\n`);
}

/**
 * A clean, fast API shutdown: exit 0, the phases exactly `phases` in order, the child's exit_call within `maxMs`, the
 * parent's time (kill -> exit event) only as the backstop. Returns the phase lines.
 */
export function expectCleanExit(
  proc: { output: () => string },
  result: { code: number | null | "timeout"; ms: number },
  options: { test: string; maxMs?: number; phases?: string[] },
): PhaseLine[] {
  const output = proc.output();
  expect(result.code, tail(output)).toBe(0);
  const phases = jsonPhases(output);
  expectPhaseOrder(phases, options.phases ?? ALL_PHASES, output);
  const call = expectChildExit(output, { code: 0, maxMs: options.maxMs ?? FAST_EXIT_MS });
  recordTiming(options.test, { exitCallMs: call.ms, exitPhaseMs: phases.at(-1)?.ms, parentMs: result.ms });
  expectParentBackstop(result.ms, output);
  return phases;
}
