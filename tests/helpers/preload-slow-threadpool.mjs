// TEST ONLY. Loaded with `node --import` by tests/helpers/sse-client.ts (startApiProcess, preload "slow-threadpool"),
// which also sets UV_THREADPOOL_SIZE=1. On SIGTERM it queues a CPU-heavy pbkdf2 job on the only libuv thread before the
// API's own handler runs, so pino's asynchronous fs.write of the shutdown lines waits behind it: the same delay a
// loaded machine gives at random, made deterministic. Nothing in apps/ references this file.
import { pbkdf2 } from "node:crypto";

process.prependListener("SIGTERM", () => {
  pbkdf2("forge", "slow-threadpool", 600_000, 64, "sha512", () => undefined);
});
