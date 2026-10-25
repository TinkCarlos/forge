// TEST ONLY. Loaded with `node --import` by tests/helpers/sse-client.ts (startApiProcess, preload "stuck-flush").
// Replaces the sonic-boom module pino loads (via the require cache, before pino is loaded) with one whose flush(cb)
// never calls back, so app.log.flush() hangs and the shutdown flush timeout is what ends the process. Writes are
// untouched. Nothing in apps/ references this file and there is no env switch for it: only a test can load it.
import { createRequire } from "node:module";

const fromPino = createRequire(createRequire(import.meta.url).resolve("pino"));
const sonicBoomPath = fromPino.resolve("sonic-boom");
const SonicBoom = fromPino("sonic-boom");
function StuckFlushSonicBoom(opts) {
  const stream = new SonicBoom(opts);
  stream.flush = () => undefined;
  return stream;
}
Object.assign(StuckFlushSonicBoom, SonicBoom);
fromPino.cache[sonicBoomPath].exports = StuckFlushSonicBoom;
