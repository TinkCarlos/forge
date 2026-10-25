// r4 shutdown: flush the logger before process.exit so the last lines are written, and written in order.
import pino from "pino";

interface FlushableLogger {
  flush?: (cb?: (err?: Error) => void) => void;
}
interface DestinationStream {
  _writing?: unknown;
  once?: (event: "drain", listener: () => void) => unknown;
}

/**
 * The only place that reads sonic-boom's private `_writing` field (true while an fs.write is in flight). The API's
 * main-thread destination is pino 9.14's sonic-boom 4.2.1; the sonic-boom 5.0.2 also in the repo is pino-pretty's (it
 * writes inside the transport worker, not here). Returns undefined when the field is not there (another stream type,
 * or a sonic-boom version without it): the caller then relies on flush(cb) alone. tests/log-flush.test.ts checks the
 * field is still a boolean on a real pino logger, so an upgrade that drops it turns that test red.
 */
function writeInFlight(stream: DestinationStream | undefined): boolean | undefined {
  const writing = stream?._writing;
  return typeof writing === "boolean" ? writing : undefined;
}

/**
 * Calls `done` once the logger has nothing left to write. pino's flush(cb) alone is not enough on its default
 * destination (an asynchronous sonic-boom on fd 1, minLength 0): sonic-boom 4.2.1 flush() calls back at once when
 * minLength <= 0 (index.js:418-421), even while an fs.write is still in flight. process.exit then runs pino's exit
 * hook, flushSync(), which skips the chunk in flight (index.js:554-557) and writes the queued lines first, so the
 * chunk in flight reaches stdout after them (SIG-09 under load). So when a write is in flight this also waits for the
 * destination's 'drain' (emitted when it has written everything). Other streams (the pino-pretty transport in
 * development, a thread-stream) have no `_writing`: their flush(cb) is used as is (it calls back once the worker
 * has the data; checked by SIG-10c under development). A logger without flush (logger: false) calls back at once.
 * The caller bounds the wait (shutdown.ts flush limit).
 */
export function flushLogger(logger: object, done: () => void): void {
  // Fastify's logger type (FastifyBaseLogger) does not declare flush; the instance is pino's, which has it.
  const flushable = logger as FlushableLogger & Record<symbol, DestinationStream | undefined>;
  if (typeof flushable.flush !== "function") {
    done();
    return;
  }
  flushable.flush(() => {
    const stream = flushable[pino.symbols.streamSym];
    if (writeInFlight(stream) === true && typeof stream?.once === "function") stream.once("drain", done);
    else done();
  });
}
