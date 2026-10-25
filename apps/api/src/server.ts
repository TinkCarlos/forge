import { config, setOutboundLogger } from "@forge/core";
import { drainRuntime, logSafeError, startRuntime } from "@forge/runtime";
import { pool } from "@forge/store";
import { writeSync } from "node:fs";
import { buildApp } from "./app.js";
import { flushLogger } from "./log-flush.js";
import { createShutdown } from "./shutdown.js";

const app = await buildApp();
// AD: blocked outbound requests (host, resolved IPs, reason) go to the API log, never to the client.
setOutboundLogger((entry) => app.log.warn(entry, "outbound request blocked"));

const port = config.PORT;
await app.listen({ port, host: config.HOST });
if (config.EMBEDDED_WORKER) startRuntime();
console.log(`Forge API listening on ${config.FORGE_PUBLIC_URL} (local http://localhost:${port})`);

// P3-07 / r5 §4: drain the runtime (no new claims; tool calls in flight finish), close the server, close the DB pool,
// flush the log (r4), then exit (0, or 1 when a step failed / a drain did not finish). Ruling 15:39: one deadline 9 s
// after the signal; Run drain min(WORKER_DRAIN_TIMEOUT_MS, 5 s), lease release 1 s, flush 2 s, each cut to it.
const shutdown = createShutdown({
  close: () => app.close(),
  runDrainTimeoutMs: config.WORKER_DRAIN_TIMEOUT_MS,
  drainRuntime: (budget) => drainRuntime(budget.drainMs, budget),
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
  log: (message, error) => app.log.error(error === undefined ? {} : { err: logSafeError(error) }, message),
  timeoutMs: 10_000,
  info: (message, fields) => app.log.info(fields, message),
  activeResources: () => process.getActiveResourcesInfo(),
  flush: (done) => flushLogger(app.log, done),
  // Not through pino: this is the line for when pino's own flush did not finish.
  writeStderrSync: (line) => {
    writeSync(2, `${line}\n`);
  },
});
const onSignal = (signal: string): void => {
  shutdown(signal).catch(() => process.exit(1));
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
