// P3-07: process shutdown on SIGTERM / SIGINT. Pure module (dependencies injected) so it is unit-testable.

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
      try {
        deps.stopRuntime();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): stopping the runtime failed`, error);
      }
      try {
        await deps.closePool();
      } catch (error) {
        code = 1;
        deps.log(`shutdown (${signal}): closing the database pool failed`, error);
      }
      clearTimeout(timer);
      deps.exit(code);
    })();
    return running;
  };
}
