import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// P3-07 (pure): SIGTERM / SIGINT -> stop taking requests (app.close) -> stop runtime ticks -> close the DB pool ->
// exit 0. A failing step is logged and the exit code is non-zero (no unhandled rejection); a hard timeout forces
// exit 1. A second signal while shutting down does not start a second shutdown. A Run in progress is not awaited: its
// lease is released by runClaimed if it can, otherwise it expires and another worker reclaims the Run (P3-09 / X-01).
const { createShutdown } = await import("../apps/api/src/shutdown.js");

function deps(over: Partial<Record<string, unknown>> = {}) {
  const order: string[] = [];
  const d = {
    close: vi.fn(async () => { order.push("close"); }),
    stopRuntime: vi.fn(() => { order.push("stopRuntime"); }),
    closePool: vi.fn(async () => { order.push("closePool"); }),
    exit: vi.fn((code: number) => { order.push(`exit:${code}`); }),
    log: vi.fn(),
    timeoutMs: 10_000,
    ...over,
  };
  return { d, order };
}
afterEach(() => vi.useRealTimers());

describe("P3-07 graceful shutdown", () => {
  it("close -> stopRuntime -> closePool -> exit 0", async () => {
    const { d, order } = deps();
    await createShutdown(d as never)("SIGTERM");
    expect(order).toEqual(["close", "stopRuntime", "closePool", "exit:0"]);
    expect(d.log).not.toHaveBeenCalled();
  });

  it("app.close throws -> logged, runtime and pool still stopped, exit non-zero, no rejection", async () => {
    const { d, order } = deps({ close: vi.fn(async () => { throw new Error("close failed"); }) });
    await expect(createShutdown(d as never)("SIGTERM")).resolves.toBeUndefined();
    expect(order).toEqual(["stopRuntime", "closePool", "exit:1"]);
    expect(d.log).toHaveBeenCalledTimes(1);
  });

  it("pool.end throws -> exit non-zero", async () => {
    const { d, order } = deps({ closePool: vi.fn(async () => { throw new Error("pool"); }) });
    await createShutdown(d as never)("SIGINT");
    expect(order.at(-1)).toBe("exit:1");
  });

  it("a hung close is cut off by the timeout: exit 1", async () => {
    vi.useFakeTimers();
    const { d } = deps({ close: vi.fn(() => new Promise<void>(() => undefined)) });
    void createShutdown(d as never)("SIGTERM").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(d.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it("a second signal does not run a second shutdown", async () => {
    const { d } = deps();
    const shutdown = createShutdown(d as never);
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM")]);
    expect(d.close).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("server.ts wires it for SIGINT and SIGTERM, with no bare `void` handler", () => {
    const src = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    expect(src).toContain("createShutdown(");
    expect(src).toMatch(/stopRuntime/);
    expect(src).toMatch(/pool\.end\(\)/);
    expect(src).not.toMatch(/=>\s*void\s+shutdown/);
    expect(src).toMatch(/process\.on\("SIGTERM"/);
    expect(src).toMatch(/process\.on\("SIGINT"/);
  });
});
