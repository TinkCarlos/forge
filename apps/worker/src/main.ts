import { config } from "@forge/core";
import { drainRuntime, startRuntime } from "@forge/runtime";
import { pool } from "@forge/store";

startRuntime();
console.log("Forge worker started");

// r5 §4: on SIGTERM / SIGINT stop claiming, let tool calls in flight finish (up to WORKER_DRAIN_TIMEOUT_MS), release
// the leases, close the DB pool and exit. A Run drain that timed out logs phase=run_drain_timeout with runIds and
// drainMs, the normal close continues and the exit is 1. The process backstop (hard stop) at drain + 5 s logs
// phase=drain_timeout and exits 1 whatever is still pending.
let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log("Forge worker stopping");
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
  } catch (error) {
    code = 1;
    console.error(JSON.stringify({ phase: "drain_failed", signal, error: error instanceof Error ? error.name : "Error" }));
  }
  try {
    await pool.end();
  } catch {
    code = 1;
  }
  clearTimeout(hardStop);
  process.exit(code);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
