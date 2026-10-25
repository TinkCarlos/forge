import { config } from "@forge/core";
import { drainRuntime, startRuntime } from "@forge/runtime";
import { pool } from "@forge/store";

startRuntime();
console.log("Forge worker started");

// r5 §4: on SIGTERM / SIGINT stop claiming, let tool calls in flight finish (up to WORKER_DRAIN_TIMEOUT_MS), release
// the leases, close the DB pool and exit. A drain that timed out logs phase=drain_timeout with the Run ids and exits
// 1; the hard stop at drain + 5 s exits 1 whatever is still pending.
let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log("Forge worker stopping");
  const hardStop = setTimeout(() => {
    console.error(JSON.stringify({ phase: "hard_stop", signal, ms: config.WORKER_DRAIN_TIMEOUT_MS + 5000 }));
    process.exit(1);
  }, config.WORKER_DRAIN_TIMEOUT_MS + 5000);
  hardStop.unref();
  let code = 0;
  try {
    const result = await drainRuntime();
    if (result.timedOut) {
      code = 1;
      console.error(JSON.stringify({ phase: "drain_timeout", signal, runIds: result.runIds, ms: result.ms }));
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
