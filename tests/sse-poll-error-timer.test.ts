import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// P3-06: when a poll of the SSE run stream throws, the stream ends AND its 500 ms interval is cleared: no later poll,
// no interval left behind. A client disconnect at the same time (close + catch both clear) must not throw.
const listEvents = vi.fn();
const getRun = vi.fn();
vi.mock("@forge/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forge/store")>();
  return { ...actual, repos: { ...actual.repos, listEvents, getRun } };
});
const { streamRun } = await import("../apps/api/src/plugins/http-helpers.js");

function fakes() {
  const raw = new EventEmitter();
  const request = { headers: {}, raw } as never;
  const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
  const reply = { hijack: vi.fn(), raw: res } as never;
  return { raw, request, reply, res };
}
afterEach(() => vi.useRealTimers());

describe("P3-06 SSE poll error clears the interval", () => {
  it("poll throws once -> ended, polled only once in the next 5 s", async () => {
    vi.useFakeTimers();
    listEvents.mockReset().mockRejectedValue(new Error("db down"));
    const { request, reply, res } = fakes();
    await streamRun(request, reply, "run_SSE");
    await vi.advanceTimersByTimeAsync(5000);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("client disconnects right after the failing poll: no error, timer gone", async () => {
    vi.useFakeTimers();
    listEvents.mockReset().mockRejectedValue(new Error("db down"));
    const { raw, request, reply } = fakes();
    await streamRun(request, reply, "run_SSE");
    await vi.advanceTimersByTimeAsync(500);
    expect(() => raw.emit("close")).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
