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
  /** Hard limit; when it passes the process exits 1 whatever is still pending. */
  timeoutMs: number;
  /** r4: one info line per step with the time since the signal (ms), so a slow step shows up in the log. */
  info?: (message: string, fields: Record<string, unknown>) => void;
  /** r4: what is still open right before exit (process.getActiveResourcesInfo), logged with the exit step. */
  activeResources?: () => string[];
}

/** Counts of each resource type, e.g. { TCPSocketWrap: 1, Timeout: 2 }. */
function countResources(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

/**
 * close -> stopRuntime -> closePool -> exit(0). A failing step is logged, the later steps still run and the exit
 * code is 1; the returned promise never rejects. A second call (second signal) returns the first shutdown. A Run in
 * progress is not awaited: its lease is released by runClaimed if possible, otherwise it expires and is reclaimed.
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
      step("signal");
      // Backstop. Also what ends a shutdown held by a connection that sent only part of its request headers and
      // stalled: it is neither unused nor idle, so it is never closed (see closeUnusedConnections in
      // plugins/sse-shutdown.ts) and the exit is 1 after timeoutMs. Normal clients never do this.
      const timer = setTimeout(() => {
        deps.log(`shutdown (${signal}) timed out after ${deps.timeoutMs} ms`);
        deps.exit(1);
      }, deps.timeoutMs);
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
      clearTimeout(timer);
      step("exit", { code, ...(deps.activeResources ? { activeResources: countResources(deps.activeResources()) } : {}) });
      deps.exit(code);
    })();
    return running;
  };
}
