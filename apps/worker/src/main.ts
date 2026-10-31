import { config } from "@forge/core";
import { drainRuntime, startRuntime } from "@forge/runtime";
import { pool } from "@forge/store";

startRuntime();
console.log("Forge worker started");

// r5 §4: on SIGTERM / SIGINT stop claiming, let tool calls in flight finish (up to WORKER_DRAIN_TIMEOUT_MS), release
// the leases, close the DB pool and exit. A Run drain that timed out logs phase=run_drain_timeout with runIds and
// drainMs, the normal close continues and the exit is 1. Ruling 15:39 (same rule as the API): a lease is released
// only once all tool calls of its Run have ended (release step at most 1 s); then one run_handoff line per Run
// {runId, takeover, reason}. The process backstop (hard stop) at drain + 5 s logs phase=drain_timeout and exits 1
// whatever is still pending.
// r6 pool-end-cap: pool.end() gets at most POOL_END_CAP_MS (and never past the hard stop). A database that stops
// answering leaves mysql2's end() pending for good; when the limit runs out: phase=pool_end_timeout {signal,
// poolEndMs}, exit 1.
/** pool.end() limit on shutdown (the API's close slice is the same 1000 ms). */
const POOL_END_CAP_MS = 1000;
/** Kept between the end of the pool.end() limit and the hard stop, so the limit always runs out first. */
const HARD_STOP_MARGIN_MS = 100;
let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log("Forge worker stopping");
  const hardStopAt = Date.now() + config.WORKER_DRAIN_TIMEOUT_MS + 5000;
  const hardStop = setTimeout(() => {
    console.error(JSON.stringify({ phase: "drain_timeout", signal, code: 1, ms: config.WORKER_DRAIN_TIMEOUT_MS + 5000 }));
    process.exit(1);
  }, config.WORKER_DRAIN_TIMEOUT_MS + 5000);
  hardStop.unref();
  let code = 0;
  try {
    const result = await drainRuntime();
    if (result.timedOut) {
      code = 1;
      console.error(JSON.stringify({ phase: "run_drain_timeout", signal, runIds: result.runIds, drainMs: result.ms }));
    }
    const releaseTimedOut = result.handoffs.filter((handoff) => handoff.reason === "release_timeout").map((handoff) => handoff.runId);
    if (releaseTimedOut.length > 0) {
      console.error(JSON.stringify({ phase: "release_timeout", signal, runIds: releaseTimedOut, releaseMs: result.releaseMs }));
    }
    for (const handoff of result.handoffs) {
      const line = { phase: "run_handoff", signal, runId: handoff.runId, takeover: handoff.takeover, reason: handoff.reason };
      console.error(JSON.stringify(line));
    }
  } catch (error) {
    code = 1;
    console.error(JSON.stringify({ phase: "drain_failed", signal, error: error instanceof Error ? error.name : "Error" }));
  }
  const poolEndMs = Math.max(0, Math.min(POOL_END_CAP_MS, hardStopAt - HARD_STOP_MARGIN_MS - Date.now()));
  let poolTimer: ReturnType<typeof setTimeout> | undefined;
  const poolEnded = await Promise.race([
    Promise.resolve()
      .then(() => pool.end())
      .then(
        () => true,
        () => {
          code = 1;
          return true;
        },
      ),
    // Not unref'd (unlike the hard stop): a pending end() holds no handle of its own, so without this timer the
    // process would just run out of work and exit 0.
    new Promise<false>((resolve) => {
      poolTimer = setTimeout(() => resolve(false), poolEndMs);
    }),
  ]);
  clearTimeout(poolTimer);
  if (!poolEnded) {
    code = 1;
    console.error(JSON.stringify({ phase: "pool_end_timeout", signal, poolEndMs }));
  }
  clearTimeout(hardStop);
  process.exit(code);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
