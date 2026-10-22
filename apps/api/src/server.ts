import { config, setOutboundLogger } from "@forge/core";
import { startRuntime } from "@forge/runtime";
import { buildApp } from "./app.js";

const app = await buildApp();
// AD: blocked outbound requests (host, resolved IPs, reason) go to the API log, never to the client.
setOutboundLogger((entry) => app.log.warn(entry, "outbound request blocked"));

const port = config.PORT;
await app.listen({ port, host: config.HOST });
if (config.EMBEDDED_WORKER) startRuntime();
console.log(`Forge API listening on ${config.FORGE_PUBLIC_URL} (local http://localhost:${port})`);

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
