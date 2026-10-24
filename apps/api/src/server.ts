import { config, setOutboundLogger } from "@forge/core";
import { logSafeError, startRuntime, stopRuntime } from "@forge/runtime";
import { pool } from "@forge/store";
import { buildApp } from "./app.js";
import { createShutdown } from "./shutdown.js";

const app = await buildApp();
// AD: blocked outbound requests (host, resolved IPs, reason) go to the API log, never to the client.
setOutboundLogger((entry) => app.log.warn(entry, "outbound request blocked"));

const port = config.PORT;
await app.listen({ port, host: config.HOST });
if (config.EMBEDDED_WORKER) startRuntime();
console.log(`Forge API listening on ${config.FORGE_PUBLIC_URL} (local http://localhost:${port})`);

// P3-07: close the server, stop runtime ticks, close the DB pool, then exit (0, or 1 when a step failed / after 10 s).
const shutdown = createShutdown({
  close: () => app.close(),
  stopRuntime,
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
  log: (message, error) => app.log.error(error === undefined ? {} : { err: logSafeError(error) }, message),
  timeoutMs: 10_000,
});
const onSignal = (signal: string): void => {
  shutdown(signal).catch(() => process.exit(1));
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
