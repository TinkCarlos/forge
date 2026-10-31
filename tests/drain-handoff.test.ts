import { afterEach, describe, expect, it, vi } from "vitest";
import { expectHandoffMapping } from "./helpers/run-handoff.js";

// Ruling 15:39 (pure, packages/runtime/src/drain.ts): the drain waits for the Runs up to its limit, then the release
// step (at most releaseMs, cut to the deadline) releases the lease of every Run whose tool calls have all ended. A Run
// with a tool call still running after the abort is not released (lease expiry). One handoff per Run:
// drained -> released; tool_inflight / release_timeout / release_error -> lease_expiry.
const drain = await import("../packages/runtime/src/drain.js");

afterEach(() => {
  vi.useRealTimers();
  drain.resetDrain();
});

// r6 A19: drainRuns only uses Date.now and setTimeout, so its step limits are asserted exactly under vi fake timers
// (no wall-clock bound that load can break): the promise is still pending 1 ms before `atMs` and settled at `atMs`.
async function settlesAt<T>(pending: Promise<T>, atMs: number): Promise<T> {
  let settled = false;
  void pending.then(() => (settled = true), () => (settled = true));
  await vi.advanceTimersByTimeAsync(atMs - 1);
  expect(settled, `drainRuns already settled before ${atMs} ms`).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled, `drainRuns not settled at ${atMs} ms`).toBe(true);
  return pending;
}

const never = () => new Promise<void>(() => undefined);
let n = 0;
const id = () => `r-${++n}`;

describe("drain handoff (ruling 15:39)", () => {
  it("drained: the Run hands over once its tool calls ended; its lease is released -> takeover released", async () => {
    const runId = id();
    const reg = drain.registerRun(runId, () => undefined);
    const release = vi.fn(async () => undefined);
    reg.signal.addEventListener("abort", () => setTimeout(() => reg.handOff(release), 20));
    const result = await drain.drainRuns(1000, { releaseMs: 1000 });
    expect(result).toMatchObject({ timedOut: false, runIds: [], releaseTimedOut: false });
    expect(result.handoffs).toEqual([{ runId, takeover: "released", reason: "drained" }]);
    expect(release).toHaveBeenCalledTimes(1);
    expectHandoffMapping(result.handoffs);
  });

  it("tool_inflight: a tool call that ignores the abort is never released (lease expiry); the steps stay within their limits", async () => {
    const runId = id();
    const hardAbort = vi.fn();
    const reg = drain.registerRun(runId, hardAbort);
    reg.toolStarted(); // never ends
    const release = vi.fn(async () => undefined);
    vi.useFakeTimers();
    // The drain step ends at its 200 ms limit (hard abort), the release step at its 300 ms limit: settled at 500.
    const result = await settlesAt(drain.drainRuns(200, { releaseMs: 300 }), 200 + 300);
    expect(hardAbort, JSON.stringify(result)).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ timedOut: true, runIds: [runId], releaseTimedOut: true, ms: 200, releaseMs: 300 });
    expect(result.handoffs).toEqual([{ runId, takeover: "lease_expiry", reason: "tool_inflight" }]);
    reg.handOff(release); // too late: the drain is over
    await vi.advanceTimersByTimeAsync(20);
    expect(release).not.toHaveBeenCalled();
    expectHandoffMapping(result.handoffs);
  });

  it("a tool call that ends after the hard abort, within the release step: all calls ended -> released (drained)", async () => {
    const runId = id();
    const reg = drain.registerRun(runId, () => {
      setTimeout(() => {
        end();
        reg.handOff(release);
      }, 50);
    });
    const end = reg.toolStarted();
    const release = vi.fn(async () => undefined);
    const result = await drain.drainRuns(100, { releaseMs: 1000 });
    expect(result).toMatchObject({ timedOut: true, runIds: [runId], releaseTimedOut: false });
    expect(result.handoffs).toEqual([{ runId, takeover: "released", reason: "drained" }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("the handover itself is held while a tool call is still running (not released, tool_inflight)", async () => {
    const runId = id();
    const reg = drain.registerRun(runId, () => undefined);
    reg.toolStarted(); // abandoned call still running
    const release = vi.fn(async () => undefined);
    reg.signal.addEventListener("abort", () => reg.handOff(release));
    const result = await drain.drainRuns(100, { releaseMs: 100 });
    expect(release).not.toHaveBeenCalled();
    expect(result.handoffs).toEqual([{ runId, takeover: "lease_expiry", reason: "tool_inflight" }]);
  });

  it("release_timeout: a release that hangs is skipped after releaseMs -> lease_expiry", async () => {
    const runId = id();
    const reg = drain.registerRun(runId, () => undefined);
    reg.signal.addEventListener("abort", () => reg.handOff(never));
    vi.useFakeTimers();
    // The Run hands over at once (drain step 0 ms); the hanging release is cut at its 200 ms limit.
    const result = await settlesAt(drain.drainRuns(1000, { releaseMs: 200 }), 200);
    expect(result).toMatchObject({ timedOut: false, releaseTimedOut: true, ms: 0, releaseMs: 200 });
    expect(result.handoffs).toEqual([{ runId, takeover: "lease_expiry", reason: "release_timeout" }]);
    expectHandoffMapping(result.handoffs);
  });

  it("release_error: a release that fails -> lease_expiry", async () => {
    const runId = id();
    const reg = drain.registerRun(runId, () => undefined);
    reg.signal.addEventListener("abort", () => reg.handOff(async () => { throw new Error("db"); }));
    const result = await drain.drainRuns(1000, { releaseMs: 200 });
    expect(result.handoffs).toEqual([{ runId, takeover: "lease_expiry", reason: "release_error" }]);
    expectHandoffMapping(result.handoffs);
  });

  it("several Runs: one line each, mapping holds for all", async () => {
    const ok = id();
    const stuck = id();
    const failing = id();
    const a = drain.registerRun(ok, () => undefined);
    a.signal.addEventListener("abort", () => a.handOff(async () => undefined));
    drain.registerRun(stuck, () => undefined).toolStarted();
    const c = drain.registerRun(failing, () => undefined);
    c.signal.addEventListener("abort", () => c.handOff(async () => { throw new Error("x"); }));
    const result = await drain.drainRuns(100, { releaseMs: 100 });
    expect(new Map(result.handoffs.map((h) => [h.runId, [h.takeover, h.reason]]))).toEqual(new Map([
      [ok, ["released", "drained"]],
      [stuck, ["lease_expiry", "tool_inflight"]],
      [failing, ["lease_expiry", "release_error"]],
    ]));
    expectHandoffMapping(result.handoffs);
  });

  it("the deadline cuts both steps: drain and release never wait past deadlineAt", async () => {
    const runId = id();
    drain.registerRun(runId, () => undefined).toolStarted();
    vi.useFakeTimers();
    // The drain step is cut from 5000 to the deadline (300 ms), the release step from 1000 to what is left (0 ms: a
    // setTimeout(0), which Node runs as 1 ms): settled at 301, never at the 1000 ms release limit.
    const result = await settlesAt(drain.drainRuns(5000, { releaseMs: 1000, deadlineAt: Date.now() + 300 }), 300 + 1);
    expect(result).toMatchObject({ timedOut: true, runIds: [runId], ms: 300, releaseMs: 0, releaseTimedOut: true });
    expect(result.handoffs).toEqual([{ runId, takeover: "lease_expiry", reason: "tool_inflight" }]);
  });

  it("a Run that finished on its own before the drain (done) gets no handoff line", async () => {
    const reg = drain.registerRun(id(), () => undefined);
    reg.done();
    const result = await drain.drainRuns(100, { releaseMs: 100 });
    expect(result.handoffs).toEqual([]);
    expect(result.timedOut).toBe(false);
  });
});
