// P3-07: process shutdown on SIGTERM / SIGINT. Pure module (dependencies injected) so it is unit-testable.
import { nextPhaseSeq } from "./phase-seq.js";

export interface ShutdownDeps {
  /** Stop taking requests and wait for in-flight ones (Fastify app.close). */
  close: () => Promise<void>;
  /** Stop the worker / scheduler ticks (no-op when the runtime is not embedded). */
  stopRuntime: () => void;
  /** Close the DB connection pool. */
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  /** Log a failed step; `error` must be logged in its sanitized form by the caller. */
  log: (message: string, error?: unknown) => void;
  /** Hard limit; the process has exited (1 when the drain did not finish) before it passes. */
  timeoutMs: number;
  /** r4: one info line per step with the time since the signal (ms), so a slow step shows up in the log. */
  info?: (message: string, fields: Record<string, unknown>) => void;
  /** r4: what is still open right before exit (process.getActiveResourcesInfo), logged with the exit step. */
  activeResources?: () => string[];
  /** r4: flush the logger; `done` once everything is written. Without it the exit is immediate. */
  flush?: (done: () => void) => void;
  /** r4: write one line to stderr synchronously, bypassing the logger (used when the flush did not finish). */
  writeStderrSync?: (line: string) => void;
}

/** r4: limit for the logger flush after the exit line (fixed, not configurable). */
export const FLUSH_TIMEOUT_MS = 2000;
/** r4: limit for the logger flush when the backstop fires. */
export const BACKSTOP_FLUSH_MS = 500;
/** r4: time kept free before timeoutMs for process.exit itself (pino's exit hook, libuv teardown). */
const EXIT_MARGIN_MS = 500;

/** Counts of each resource type, e.g. { TCPSocketWrap: 1, Timeout: 2 }. */
function countResources(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

/**
 * close -> stopRuntime -> closePool -> exit line -> logger flush -> exit(code). A failing step is logged, the later
 * steps still run and the exit code is 1; the returned promise never rejects. A second call (second signal) returns
 * the first shutdown. A Run in progress is not awaited: its lease is released by runClaimed if possible, otherwise it
 * expires and is reclaimed.
 *
 * Exit and the 10 s limit (timeoutMs): the drain (close, stopRuntime, closePool) has until timeoutMs - 1000. If it is
 * not done by then the backstop logs drain_timeout, flushes for at most BACKSTOP_FLUSH_MS and exits 1. Otherwise the
 * flush after the exit line gets FLUSH_TIMEOUT_MS, cut to what is left before timeoutMs - EXIT_MARGIN_MS. A flush that
 * does not call back in time writes one `flush_timeout` JSON line straight to stderr and the exit code stays the
 * drain's (0, or 1 when a step failed). Only one of the two paths exits.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (signal: string) => {
    running ??= (async () => {
      let code = 0;
      // ms in these phase lines counts from the signal. plugins/sse-shutdown.ts logs its own phases with ms counted
      // from Fastify's preClose hook instead (a few ms later), so the two ms series do not share a zero.
      const startedAt = Date.now();
      // phaseSeq: shared with plugins/sse-shutdown.ts (phase-seq.ts), the order the phases were logged in.
      const step = (phase: string, extra: Record<string, unknown> = {}): void =>
        deps.info?.(`shutdown (${signal}): ${phase}`, { phase, phaseSeq: nextPhaseSeq(), ms: Date.now() - startedAt, ...extra });

      let finishing: Promise<void> | null = null;
      /** Flush the logger for at most `limitMs`, then exit(exitCode). Only the first call does anything. */
      const finish = (exitCode: number, limitMs: number): Promise<void> => {
        finishing ??= new Promise<void>((resolve) => {
          let exited = false;
          let flushTimer: ReturnType<typeof setTimeout> | undefined;
          const exitOnce = (): void => {
            if (exited) return;
            exited = true;
            clearTimeout(flushTimer);
            deps.exit(exitCode);
            resolve();
          };
          if (!deps.flush) {
            exitOnce();
            return;
          }
          const flushStartedAt = Date.now();
          // Not unref'd: while the flush hangs this timer is what keeps the process alive until the exit below.
          flushTimer = setTimeout(() => {
            if (exited) return;
            const line = {
              level: 40,
              time: Date.now(),
              phase: "flush_timeout",
              phaseSeq: nextPhaseSeq(),
              ms: Date.now() - startedAt,
              flushMs: Date.now() - flushStartedAt,
              timeoutMs: limitMs,
              code: exitCode,
              msg: `shutdown (${signal}): logger flush did not finish in ${limitMs} ms`,
            };
            try {
              deps.writeStderrSync?.(JSON.stringify(line));
            } catch {
              // stderr gone: nothing left to tell
            }
            exitOnce();
          }, limitMs);
          try {
            deps.flush(exitOnce);
          } catch {
            exitOnce();
          }
        });
        return finishing;
      };

      step("signal");
      // Backstop. Also what ends a shutdown held by a connection that sent only part of its request headers and
      // stalled: it is neither unused nor idle, so it is never closed (see closeUnusedConnections in
      // plugins/sse-shutdown.ts) and the exit is 1 at timeoutMs - 1000 (+ at most BACKSTOP_FLUSH_MS of flush).
      // Normal clients never do this.
      const drainDeadlineMs = deps.timeoutMs - BACKSTOP_FLUSH_MS - EXIT_MARGIN_MS;
      const timer = setTimeout(() => {
        if (finishing) return;
        deps.log(`shutdown (${signal}) timed out after ${deps.timeoutMs} ms`);
        step("drain_timeout", { code: 1 });
        void finish(1, BACKSTOP_FLUSH_MS);
      }, drainDeadlineMs);
      timer.unref?.();
      try {
        await deps.close();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): closing the HTTP server failed`, error);
      }
      step("app_close");
      try {
        deps.stopRuntime();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): stopping the runtime failed`, error);
      }
      step("stop_runtime");
      try {
        await deps.closePool();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): closing the database pool failed`, error);
      }
      step("pool_end");
      // The backstop already fired (drain_timeout): it does the exit, with code 1.
      if (finishing) return finishing;
      clearTimeout(timer);
      step("exit", { code, ...(deps.activeResources ? { activeResources: countResources(deps.activeResources()) } : {}) });
      const flushLimitMs = Math.max(0, Math.min(FLUSH_TIMEOUT_MS, startedAt + deps.timeoutMs - EXIT_MARGIN_MS - Date.now()));
      return finish(code, flushLimitMs);
    })();
    return running;
  };
}
