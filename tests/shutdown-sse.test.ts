import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";
import { freePort, keepAliveGet, openSse, partialRequest, probeNewConnection, rawConnection, startApiProcess, type ApiProcess } from "./helpers/sse-client.js";

// SIG-xx (r4 shutdown): on SIGTERM the API ends every open SSE stream itself (no completed / shutdown event, the
// connection is simply finished, so EventSource reconnects with Last-Event-ID), stops listening BEFORE ending them
// (a reconnect gets ECONNREFUSED and keeps retrying instead of a 503 that would close EventSource), answers SSE and
// /readyz on already-open keep-alive connections with 503 (SYS-9003 + Retry-After: 1 / the not_ready body), and exits
// 0 well inside the 10 s backstop. Real API child processes on free non-reserved ports; *_test DB only.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let adminHeaders: Record<string, string> = {};
let openKey = "";
let agentId = "";
let versionId = "";
let appId = "";
const runs: string[] = [];
const processes: ApiProcess[] = [];

async function newRun(): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, appId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "sig" }, status: "running" });
  runs.push(runId);
  return runId;
}
const adminPath = (runId: string) => `/admin/api/runs/${runId}/events`;
const openPath = (runId: string) => `/open/v1/runs/${runId}/events`;
async function api(): Promise<ApiProcess> {
  const proc = await startApiProcess();
  processes.push(proc);
  return proc;
}
/** SIGTERM, then wait at most `limitMs` for the exit; returns code and elapsed ms (code "timeout" when still alive). */
async function sigterm(proc: ApiProcess, limitMs: number): Promise<{ code: number | null | "timeout"; ms: number }> {
  const sent = Date.now();
  proc.child.kill("SIGTERM");
  const result = await Promise.race([proc.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), limitMs))]);
  if (!result) return { code: "timeout", ms: Date.now() - sent };
  return { code: result.code, ms: result.at - sent };
}

beforeAll(async () => {
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  adminHeaders = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-sig-${suffix}`, name: "IT sig", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, status: "published", createdBy: ADMIN_ID });
  appId = await repos.createApiApp({ key: `it-sig-${suffix}`, name: "IT sig", ownerOrgUnitId: ROOT, scopes: ["runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:read"] });
});

afterAll(async () => {
  for (const proc of processes) if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
  for (const id of runs) {
    const run = await repos.getRun(id);
    for (const table of ["run_events", "messages", "run_steps", "tool_calls"]) await execute(`DELETE FROM ${table} WHERE run_id = ?`, [id]);
    await execute("DELETE FROM runs WHERE id = ?", [id]);
    if (run?.thread_id) await execute("DELETE FROM threads WHERE id = ?", [run.thread_id]);
  }
  if (appId) {
    await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
  if (agentId) {
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  await cleanupRealSessions();
});

describe("SIG: SIGTERM with open SSE streams (API child process)", () => {
  it("SIG-09: every shutdown step logs one info line with ms, in order; no timer is left at exit", { timeout: 60_000 }, async () => {
    // Test-only slow libuv thread pool (tests/helpers/preload-slow-threadpool.mjs): pino's asynchronous write of the
    // phase lines waits behind a pbkdf2 job, the delay that reordered the lines under load (1 in 91 runs on 6479be9).
    const proc = await startApiProcess({ LOG_LEVEL: "info" }, { preload: ["slow-threadpool"] });
    processes.push(proc);
    const runId = await newRun();
    await repos.addEvent(runId, "run.started", { n: 1 });
    const stream = await openSse(proc.port, adminPath(runId), adminHeaders);
    await stream.waitFor(1);
    const idle = await rawConnection(proc.port);
    idle.write(keepAliveGet("/healthz"));
    await idle.response();
    const unused = await rawConnection(proc.port);
    const result = await sigterm(proc, 12_000);
    expect(result.code, proc.output().slice(-800)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
    await Promise.all([stream.finished, idle.closed, unused.closed]);

    const arrived = proc
      .output()
      .split("\n")
      .filter((line) => line.startsWith("{") && line.includes('"phase"'))
      .map((line) => JSON.parse(line) as { level: number; phase: string; phaseSeq: number; ms: number; msg: string; [key: string]: unknown });
    // The order of the lines on stdout is not the order they were logged in (pino writes asynchronously, see
    // apps/api/src/phase-seq.ts), so the order is checked by phaseSeq: one counter shared by shutdown.ts and
    // plugins/sse-shutdown.ts, starting at 1, strictly increasing, no number used twice.
    const steps = [...arrived].sort((a, b) => a.phaseSeq - b.phaseSeq);
    expect(steps.map((entry) => entry.phaseSeq)).toEqual(steps.map((_entry, index) => index + 1));
    // The logger is flushed (and its in-flight write awaited) before exit, so the lines also arrive in that order.
    expect(arrived.map((entry) => entry.phaseSeq)).toEqual(steps.map((entry) => entry.phaseSeq));
    expect(steps.map((entry) => entry.phase)).toEqual([
      "signal",
      "readyz_not_ready",
      "listener_closed",
      "sse_ended",
      "on_close",
      "app_close",
      "stop_runtime",
      "pool_end",
      "exit",
    ]);
    for (const entry of steps) {
      expect(entry.level, entry.phase).toBe(30); // info
      expect(typeof entry.ms, entry.phase).toBe("number");
      expect(entry.ms, entry.phase).toBeLessThan(2000);
    }
    const byPhase = Object.fromEntries(steps.map((entry) => [entry.phase, entry]));
    expect(byPhase.listener_closed).toMatchObject({ listening: false, unusedConnectionsClosed: 1 });
    expect(byPhase.sse_ended).toMatchObject({ streams: 1 });
    expect(byPhase.exit).toMatchObject({ code: 0 });
    // At exit no timer is left (SSE poll interval, runtime tick, the 10 s backstop). Socket handles may still be
    // closing: pool.end() resolves once QUIT is sent to each MySQL connection, and a closed or destroyed socket or
    // listener releases its handle a loop turn later (listener_closed above already reports listening: false).
    // process.exit() ends them, so they cannot hold the shutdown.
    const left = byPhase.exit!.activeResources as Record<string, number>;
    expect(Object.keys(left).filter((name) => !/^(PipeWrap|TTYWrap|FSReqCallback|ProcessWrap|SignalWrap|TCPSocketWrap|TCPServerWrap)$/.test(name)), JSON.stringify(left)).toEqual([]);
  });

  it("SIG-01: one open SSE stream -> exit 0 within 2 s; the client sees a normal end with no extra event", { timeout: 60_000 }, async () => {
    const proc = await api();
    const runId = await newRun();
    await repos.addEvent(runId, "run.started", { n: 1 });
    const stream = await openSse(proc.port, adminPath(runId), adminHeaders);
    await stream.waitFor(1);
    const result = await sigterm(proc, 12_000);
    expect(result.code, proc.output().slice(-500)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
    expect(await stream.finished).toBe("end");
    expect(stream.events.map((e) => e.id)).toEqual([1]);
    expect(stream.raw()).not.toMatch(/event: (run\.completed|run\.succeeded|completed|shutdown|close)/);
    expect(proc.output()).not.toContain("timed out");
  });

  it("SIG-02: several open SSE streams (admin and open API, two runs) -> all end normally, exit 0 within 2 s", { timeout: 60_000 }, async () => {
    const proc = await api();
    const a = await newRun();
    const b = await newRun();
    const streams = [
      await openSse(proc.port, adminPath(a), adminHeaders),
      await openSse(proc.port, adminPath(a), adminHeaders),
      await openSse(proc.port, adminPath(b), adminHeaders),
      await openSse(proc.port, openPath(b), { authorization: `Bearer ${openKey}` }),
    ];
    const result = await sigterm(proc, 12_000);
    expect(result.code, proc.output().slice(-500)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
    expect(await Promise.all(streams.map((s) => s.finished))).toEqual(["end", "end", "end", "end"]);
  });

  it("SIG-03: no SSE stream -> exit 0 within 2 s (unchanged)", { timeout: 60_000 }, async () => {
    const proc = await api();
    const ready = await fetch(`http://127.0.0.1:${proc.port}/readyz`);
    expect(ready.status).toBe(200);
    const result = await sigterm(proc, 12_000);
    expect(result.code, proc.output().slice(-500)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
  });

  it("SIG-04: reconnect with the same Last-Event-ID to a new API process -> no seq repeated, none lost", { timeout: 90_000 }, async () => {
    const first = await api();
    const runId = await newRun();
    for (let i = 1; i <= 3; i += 1) await repos.addEvent(runId, "tool.completed", { n: i });
    const before = await openSse(first.port, adminPath(runId), adminHeaders);
    await before.waitFor(3);
    const result = await sigterm(first, 12_000);
    expect(result.code).toBe(0);
    expect(await before.finished).toBe("end");
    const lastEventId = String(before.events.at(-1)!.id);
    // Written while no API is up (the run goes on in the worker).
    for (let i = 4; i <= 5; i += 1) await repos.addEvent(runId, "tool.completed", { n: i });
    const second = await api();
    const after = await openSse(second.port, adminPath(runId), { ...adminHeaders, "last-event-id": lastEventId });
    await after.waitFor(2);
    await repos.addEvent(runId, "tool.completed", { n: 6 });
    await after.waitFor(3);
    await repos.updateRun(runId, { status: "succeeded" });
    expect(await after.finished).toBe("end");
    const seqs = [...before.events, ...after.events].map((e) => e.id);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await sigterm(second, 12_000)).code).toBe(0);
  });

  it("SIG-05: once the streams have ended, a new TCP connection for SSE is refused (not an HTTP 503)", { timeout: 60_000 }, async () => {
    const proc = await api();
    const runId = await newRun();
    const stream = await openSse(proc.port, adminPath(runId), adminHeaders);
    const exit = sigterm(proc, 12_000);
    expect(await stream.finished).toBe("end");
    const probe = await probeNewConnection(proc.port, adminPath(runId), adminHeaders);
    expect(probe).toBe("refused");
    expect((await exit).code).toBe(0);
  });
});

describe("SIG: requests on an already-open keep-alive connection during shutdown (in-process app)", () => {
  async function listening() {
    const app = await buildApp({ logger: false });
    const port = await freePort();
    await app.listen({ port, host: "127.0.0.1" });
    return { app, port };
  }
  /** Splits raw HTTP/1.1 output into responses: status line, headers, body. */
  function responses(raw: string): Array<{ status: number; headers: Record<string, string>; body: string }> {
    const out: Array<{ status: number; headers: Record<string, string>; body: string }> = [];
    for (const part of raw.split(/(?=HTTP\/1\.1 \d{3})/)) {
      const [head, ...rest] = part.split("\r\n\r\n");
      const lines = head!.split("\r\n");
      const status = Number(/HTTP\/1\.1 (\d{3})/.exec(lines[0]!)?.[1] ?? 0);
      if (!status) continue;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      out.push({ status, headers, body: rest.join("\r\n\r\n") });
    }
    return out;
  }
  const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) =>
    Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms))]);

  /** Starts app.close() and waits until the listening socket is closed (step 2; draining began in preClose). */
  // Returns the close promise wrapped in an object: an async function returning a bare promise would flatten it
  // and wait for app.close() to finish, which cannot happen while the half-sent request keeps its connection open.
  async function startClose(app: Awaited<ReturnType<typeof listening>>["app"]): Promise<{ closing: Promise<void> }> {
    const closing = app.close();
    const started = Date.now();
    while (app.server.listening) {
      if (Date.now() - started > 2000) throw new Error("app.close() did not start draining");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { closing };
  }

  it("SIG-06: a new SSE request on an already-open keep-alive connection while draining -> 503 SYS-9003, Retry-After: 1, Connection: close", { timeout: 30_000 }, async () => {
    const { app, port } = await listening();
    const runId = await newRun();
    const pending = await partialRequest(port, adminPath(runId), { ...adminHeaders, accept: "text/event-stream" });
    const { closing } = await startClose(app);
    const raw = await withTimeout(pending.finish(), 3000, "keep-alive connection");
    const [answer] = responses(raw);
    expect(answer?.status, raw.slice(0, 400)).toBe(503);
    expect(answer?.headers["retry-after"]).toBe("1");
    expect(answer?.headers.connection).toBe("close");
    expect(answer?.body).toContain('"SYS-9003"');
    expect(raw).not.toContain("text/event-stream");
    await withTimeout(closing, 3000, "app.close()");
  });

  it("SIG-07: /readyz on an already-open keep-alive connection while draining -> the existing not-ready answer (503, not_ready), Connection: close", { timeout: 30_000 }, async () => {
    const { app, port } = await listening();
    const pending = await partialRequest(port, "/readyz", {});
    const { closing } = await startClose(app);
    const raw = await withTimeout(pending.finish(), 3000, "keep-alive connection");
    const [ready] = responses(raw);
    expect(ready?.status, raw.slice(0, 400)).toBe(503);
    expect(ready?.headers.connection).toBe("close");
    const body = JSON.parse(ready!.body) as Record<string, unknown>;
    expect(body).toEqual({ status: "not_ready", database: true });
    await withTimeout(closing, 3000, "app.close()");
  });

  it("SIG-08: an ordinary request on an already-open keep-alive connection while draining -> the 503 Fastify gave before, Connection: close", { timeout: 30_000 }, async () => {
    const { app, port } = await listening();
    const pending = await partialRequest(port, "/healthz", {});
    const { closing } = await startClose(app);
    const raw = await withTimeout(pending.finish(), 3000, "keep-alive connection");
    const [answer] = responses(raw);
    expect(answer?.status, raw.slice(0, 400)).toBe(503);
    expect(answer?.headers.connection).toBe("close");
    expect(JSON.parse(answer!.body)).toEqual({ error: "Service Unavailable", message: "Service Unavailable", statusCode: 503 });
    await withTimeout(closing, 3000, "app.close()");
  });
});
