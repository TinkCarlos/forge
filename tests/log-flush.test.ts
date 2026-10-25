import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { flushLogger } from "../apps/api/src/log-flush.js";

// r4: pino's flush(cb) on its default destination calls back at once (sonic-boom 4.2.1 flush: minLength 0) even
// while a write is still in flight; flushLogger also waits for that write ('drain') so nothing is left for pino's
// exit hook to write out of order.
function fakeLogger(writing: boolean) {
  const stream = Object.assign(new EventEmitter(), { _writing: writing });
  const logger = { flush: vi.fn((cb: () => void) => cb()), [pino.symbols.streamSym]: stream };
  return { logger, stream };
}

describe("flushLogger", () => {
  it("a write in flight: calls back only after the destination drained", () => {
    const { logger, stream } = fakeLogger(true);
    const done = vi.fn();
    flushLogger(logger as never, done);
    expect(logger.flush).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    stream.emit("drain");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("nothing in flight: calls back as soon as pino's flush did", () => {
    const { logger } = fakeLogger(false);
    const done = vi.fn();
    flushLogger(logger as never, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a logger without flush (logger: false) or with another stream (pino-pretty transport): calls back after flush", () => {
    const done = vi.fn();
    flushLogger({} as never, done);
    expect(done).toHaveBeenCalledTimes(1);
    const other = { flush: vi.fn((cb: () => void) => cb()) };
    flushLogger(other as never, done);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("the destination has no _writing field (another sonic-boom version / stream type): falls back to flush(cb) alone, no throw", () => {
    const stream = new EventEmitter(); // no _writing
    const once = vi.spyOn(stream, "once");
    const logger = { flush: vi.fn((cb: () => void) => cb()), [pino.symbols.streamSym]: stream };
    const done = vi.fn();
    expect(() => flushLogger(logger as never, done)).not.toThrow();
    expect(done).toHaveBeenCalledTimes(1);
    expect(once).not.toHaveBeenCalled();
    // _writing of another type (not a boolean) is treated the same way.
    const odd = { flush: vi.fn((cb: () => void) => cb()), [pino.symbols.streamSym]: Object.assign(new EventEmitter(), { _writing: "yes" }) };
    flushLogger(odd as never, done);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("guard: the default destination of a real pino logger, and of Fastify's logger, still has a boolean _writing (sonic-boom 4.2.1)", async () => {
    // If a pino / sonic-boom upgrade drops the field, flushLogger silently stops waiting for the write in flight and
    // SIG-09 can reorder again: this test turns red first.
    const logger = pino({ level: "silent" });
    const stream = (logger as unknown as Record<symbol, { _writing?: unknown }>)[pino.symbols.streamSym];
    expect(typeof stream?._writing).toBe("boolean");
    const { default: Fastify } = await import("fastify");
    const app = Fastify({ logger: { level: "silent" } });
    const appStream = (app.log as unknown as Record<symbol, { _writing?: unknown }>)[pino.symbols.streamSym];
    expect(typeof appStream?._writing).toBe("boolean");
    await app.close();
  });

  it("a real pino logger on its default-style async destination: all lines written, in order, when done runs", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "forge-log-flush-")), "out.log");
    const logger = pino({ base: null, timestamp: false }, pino.destination({ dest: file, sync: false }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20)); // destination open
    for (let i = 1; i <= 50; i += 1) logger.info({ n: i }, "x");
    await new Promise<void>((resolve) => flushLogger(logger, resolve));
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { n: number }).n);
    expect(lines).toEqual(Array.from({ length: 50 }, (_v, i) => i + 1));
  });
});
