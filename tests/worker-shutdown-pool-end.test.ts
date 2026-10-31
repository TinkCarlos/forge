import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SIGNAL_READY } from "./helpers/sse-client.js";
import { recordTiming, tail } from "./helpers/shutdown-assert.js";

// r6 pool-end-cap, standalone worker (real child process, apps/worker/src/main.ts): the database stops answering, so
// pool.end() never resolves (test preload tests/helpers/preload-pending-pool-end.mjs: end() returns a promise that
// never settles and holds no handle). pool.end gets at most 1000 ms, still inside the drain + 5 s hard stop: then one
// line phase=pool_end_timeout {signal, poolEndMs} and exit 1. The hard stop (phase=drain_timeout) is not reached.
// *_test DB only.
// r6 A19: the worker reports no signal -> exit time of its own (no signal/exit phases in apps/worker/src/main.ts), so
// these bounds stay on the parent's kill -> exit time: lower bound the configured 1000 ms - 1, upper bound from
// a19 MEASURE.md, every assertion with the worker's output.
/** No Run in flight: the 1000 ms pool.end cut plus start of the close and the process exit (MEASURE.md). */
const NO_RUN_EXIT_MAX_MS = 4000;
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = join(ROOT_DIR, "tests", "helpers");
const DRAIN_MS = 3000;
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

type Line = { phase?: string; signal?: string; poolEndMs?: number; code?: number };

describe("standalone worker: pool.end() that never resolves is cut at 1000 ms", () => {
  it("pool_end_timeout {poolEndMs: 1000} as the last phase, exit 1, well before the drain + 5 s hard stop", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", WORKER_DRAIN_TIMEOUT_MS: String(DRAIN_MS), WORKER_POLL_MS: "200" };
    const preloads = ["preload-signal-ready.mjs", "preload-pending-pool-end.mjs"].flatMap((file) => ["--import", pathToFileURL(join(HELPERS, file)).href]);
    const child = spawn(process.execPath, ["--import", "tsx", ...preloads, "apps/worker/src/main.ts"], { cwd: ROOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    let ready: () => void = () => undefined;
    const handlerInstalled = new Promise<void>((resolve) => (ready = resolve));
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes(SIGNAL_READY)) ready();
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await Promise.race([handlerInstalled, new Promise((_, reject) => setTimeout(() => reject(new Error(`worker never installed its SIGTERM handler\n${out}`)), 25_000))]);
    const signalledAt = Date.now();
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`worker did not exit\n${out}`)), DRAIN_MS + 10_000))]);
    const tookMs = Date.now() - signalledAt;
    const lines: Line[] = out.split("\n").filter((line) => line.startsWith("{")).map((line) => { try { return JSON.parse(line) as Line; } catch { return {}; } });
    const phases = lines.map((line) => line.phase).filter(Boolean);
    recordTiming("worker-pool-end", { tookMs, phases });
    expect(code, tail(out)).toBe(1);
    expect(phases, tail(out)).not.toContain("drain_timeout");
    expect(phases.at(-1), tail(out)).toBe("pool_end_timeout");
    expect(lines.find((line) => line.phase === "pool_end_timeout"), tail(out)).toMatchObject({ signal: "SIGTERM", poolEndMs: 1000 });
    expect(tookMs, tail(out)).toBeGreaterThanOrEqual(1000 - 1);
    // Inside the hard stop (drain + 5 s), and nowhere near it: no Run was in flight, so the drain returned at once.
    expect(tookMs, tail(out)).toBeLessThan(DRAIN_MS + 5000);
    expect(tookMs, tail(out)).toBeLessThanOrEqual(NO_RUN_EXIT_MAX_MS);
  }, 60_000);
});
