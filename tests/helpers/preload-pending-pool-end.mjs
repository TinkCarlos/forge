// TEST ONLY. Loaded with `node --import` by tests/helpers/sse-client.ts (startApiProcess, preload "pending-pool-end").
// mysql2's promise pool end() still closes the pool (its sockets go away) but returns a promise that never settles and
// holds no handle, so the shutdown waits on nothing the event loop can see: only a timer (the pool.end limit, r6) ends it.
// Nothing in apps/ references this file and there is no env switch for it: only a test can load it.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const fromStore = createRequire(fileURLToPath(new URL("../../packages/store/src/db.ts", import.meta.url)));
const { PromisePool } = fromStore("mysql2/promise");
const end = PromisePool.prototype.end;
PromisePool.prototype.end = function pendingEnd() {
  end.call(this).catch(() => undefined);
  return new Promise(() => undefined);
};
