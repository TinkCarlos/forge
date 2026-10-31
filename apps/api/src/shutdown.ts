// P3-07: process shutdown on SIGTERM / SIGINT. Pure module (dependencies injected) so it is unit-testable.
import { nextPhaseSeq } from "./phase-seq.js";

export interface DrainBudget {
  drainMs: number;
  releaseMs: number;
  /** Absolute time (ms) of the shutdown deadline. */
  deadlineAt: number;
}

/** Ruling 15:39 run_handoff fields (told to ops; names and values fixed). */
export type RunHandoffLine =
  | { runId: string; takeover: "released"; reason: "drained" }
  | { runId: string; takeover: "lease_expiry"; reason: "tool_inflight" | "release_timeout" | "release_error" };

export interface DrainOutcome {
  timedOut: boolean;
  runIds: string[];
  ms: number;
  handoffs?: RunHandoffLine[];
  releaseTimedOut?: boolean;
  releaseMs?: number;
}

export interface ShutdownDeps {
  /** Stop taking requests and wait for in-flight ones (Fastify app.close). */
  close: () => Promise<void>;
  /**
   * r5 §4: stop the worker / scheduler ticks and drain the Runs in progress (no new claims from the first moment;
   * model calls aborted, tool calls allowed to finish). Resolves with timedOut when `drainMs` ran out and the rest was
   * aborted, then releases the leases that may be released within `releaseMs` (ruling 15:39); neither step waits
   * past `deadlineAt`. `handoffs`: one per Run, logged as run_handoff.
   */
  drainRuntime: (budget: DrainBudget) => Promise<DrainOutcome>;
  /** WORKER_DRAIN_TIMEOUT_MS; the Run drain gets min(this, RUN_DRAIN_CAP_MS). Default: the cap. */
  runDrainTimeoutMs?: number;
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
/** Ruling 15:39: cap of the API's Run drain (WORKER_DRAIN_TIMEOUT_MS above it is cut to this). */
export const RUN_DRAIN_CAP_MS = 5000;
/** Ruling 15:39: cap of the lease release step. */
export const RELEASE_CAP_MS = 1000;
/**
 * pool.end() limit: the 1000 ms close slice of the deadline (less when the flush would no longer fit before it). A
 * database that stops answering leaves mysql2's end() pending for good (it waits for the in-flight queries); when the
 * limit runs out: phase pool_end_timeout {poolEndMs}, exit code 1, then the normal flush and exit.
 */
export const POOL_END_CAP_MS = 1000;

/** Counts of each resource type, e.g. { TCPSocketWrap: 1, Timeout: 2 }. */
function countResources(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

/**
 * drain (started first, so nothing new is claimed) -> close -> wait for the drain -> closePool -> exit line -> logger
 * flush -> exit(code). A failing step is logged, the later steps still run and the exit code is 1; the returned
 * promise never rejects. A Run drain that timed out logs phase=run_drain_timeout with runIds and drainMs, the close
 * continues and the exit is 1 (those Runs are taken over by another worker: after the release step when all their
 * tool calls have ended, otherwise after the lease expires). A second call (second signal) returns the first shutdown.
 *
 * Ruling 15:39, one deadline: timeoutMs - 1000 (9 s) after the signal. Each step waits min(its cap, time left before
 * the deadline): Run drain min(runDrainTimeoutMs, RUN_DRAIN_CAP_MS) (then run_drain_timeout), lease release
 * RELEASE_CAP_MS (release_timeout when it ran out), flush FLUSH_TIMEOUT_MS; 8 s together, 1 s left for closing
 * connections. After the drain one run_handoff line per Run {runId, takeover, reason}, before stop_runtime and exit.
 * The close slice also bounds pool.end() (POOL_END_CAP_MS): pool_end_timeout instead of pool_end, then flush and exit 1.
 *
 * Backstop (r4): if the drain (Run drain, close, closePool) is not done by the deadline the backstop logs
 * drain_timeout, flushes for at most BACKSTOP_FLUSH_MS and exits 1. A flush that does not call back in time writes
 * one `flush_timeout` JSON line straight to stderr and the exit code stays the drain's (0, or 1 when a step failed).
 * Only one of the two paths exits.
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
      // exit is the last phase: once it is logged (normal path or backstop), steps of a drain that finishes late are
      // not logged any more.
      let exitLogged = false;
      const step = (phase: string, extra: Record<string, unknown> = {}): void => {
        if (exitLogged) return;
        if (phase === "exit") exitLogged = true;
        deps.info?.(`shutdown (${signal}): ${phase}`, { phase, phaseSeq: nextPhaseSeq(), ms: Date.now() - startedAt, ...extra });
      };
      const exitFields = (exitCode: number): Record<string, unknown> => ({
        code: exitCode,
        ...(deps.activeResources ? { activeResources: countResources(deps.activeResources()) } : {}),
      });

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
      // Not unref'd: a drain can wait on a promise that holds no handle (nothing else keeps the event loop alive); an
      // unref'd timer let the process end there with code 0 and no exit line (SIG-12). Cleared on the normal path.
      const drainDeadlineMs = deps.timeoutMs - BACKSTOP_FLUSH_MS - EXIT_MARGIN_MS;
      const timer = setTimeout(() => {
        if (finishing) return;
        deps.log(`shutdown (${signal}) timed out after ${deps.timeoutMs} ms`);
        // Process-level backstop: phase drain_timeout (the Run drain running out is run_drain_timeout).
        step("drain_timeout", { code: 1 });
        step("exit", exitFields(1));
        void finish(1, BACKSTOP_FLUSH_MS);
      }, drainDeadlineMs);
      const deadlineAt = startedAt + drainDeadlineMs;
      const budget: DrainBudget = {
        drainMs: Math.max(0, Math.min(deps.runDrainTimeoutMs ?? RUN_DRAIN_CAP_MS, RUN_DRAIN_CAP_MS, deadlineAt - Date.now())),
        releaseMs: RELEASE_CAP_MS,
        deadlineAt,
      };
      let drain: Promise<DrainOutcome>;
      try {
        drain = deps.drainRuntime(budget);
      } catch (error) {
        drain = Promise.reject(error);
      }
      drain.catch(() => undefined);
      try {
        await deps.close();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): closing the HTTP server failed`, error);
      }
      step("app_close");
      try {
        const result = await drain;
        if (result.timedOut) {
          code = 1;
          step("run_drain_timeout", { runIds: result.runIds, drainMs: result.ms });
        }
        const handoffs = result.handoffs ?? [];
        const releaseTimedOut = handoffs.filter((handoff) => handoff.reason === "release_timeout").map((handoff) => handoff.runId);
        if (releaseTimedOut.length > 0) step("release_timeout", { runIds: releaseTimedOut, releaseMs: result.releaseMs });
        for (const handoff of handoffs) step("run_handoff", { runId: handoff.runId, takeover: handoff.takeover, reason: handoff.reason });
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): draining the runtime failed`, error);
      }
      step("stop_runtime");
      const poolEndMs = Math.max(0, Math.min(POOL_END_CAP_MS, deadlineAt - FLUSH_TIMEOUT_MS - Date.now()));
      let poolTimer: ReturnType<typeof setTimeout> | undefined;
      const poolEnded = await Promise.race([
        Promise.resolve()
          .then(() => deps.closePool())
          .then(
            () => true,
            (error: unknown) => {
              code = 1;
              deps.log(`shutdown (${signal}): closing the database pool failed`, error);
              return true;
            },
          ),
        // Not unref'd, like the backstop: a pending end() holds no handle of its own.
        new Promise<false>((resolve) => {
          poolTimer = setTimeout(() => resolve(false), poolEndMs);
        }),
      ]);
      clearTimeout(poolTimer);
      if (poolEnded) {
        step("pool_end");
      } else {
        code = 1;
        deps.log(`shutdown (${signal}): closing the database pool did not finish in ${poolEndMs} ms`);
        step("pool_end_timeout", { poolEndMs });
      }
      // The backstop already fired (drain_timeout): it does the exit, with code 1.
      if (finishing) return finishing;
      clearTimeout(timer);
      step("exit", exitFields(code));
      const flushLimitMs = Math.max(0, Math.min(FLUSH_TIMEOUT_MS, deadlineAt - Date.now()));
      return finish(code, flushLimitMs);
    })();
    return running;
  };
}
