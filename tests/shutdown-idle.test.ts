import { afterAll, describe, expect, it } from "vitest";
import { keepAliveGet, rawConnection, startApiProcess, type ApiProcess } from "./helpers/sse-client.js";

// Shutdown with no SSE stream but a connection that is open and has no request in flight (QA on 99289c0: SIGTERM
// sometimes still waited the full 10 s with no SSE and the last request finished). Real API child process.
const children: ApiProcess[] = [];
afterAll(() => {
  for (const proc of children) if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
});
async function api(): Promise<ApiProcess> {
  const proc = await startApiProcess();
  children.push(proc);
  return proc;
}
async function sigterm(proc: ApiProcess, limitMs: number): Promise<{ code: number | null | "timeout"; ms: number }> {
  const sent = Date.now();
  proc.child.kill("SIGTERM");
  const result = await Promise.race([proc.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), limitMs))]);
  if (!result) return { code: "timeout", ms: Date.now() - sent };
  return { code: result.code, ms: result.at - sent };
}

describe("IDLE: SIGTERM with an idle connection and no SSE stream", () => {
  it("IDLE-01: one keep-alive connection, idle after a finished request -> exit 0 within 2 s", { timeout: 30_000 }, async () => {
    const proc = await api();
    const conn = await rawConnection(proc.port);
    conn.write(keepAliveGet("/healthz"));
    expect(await conn.response()).toMatch(/^HTTP\/1\.1 200/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await sigterm(proc, 2000);
    expect(result.code, proc.output().slice(-600)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
    expect(proc.output()).not.toContain("timed out");
  });

  it("IDLE-02: one connection opened but no request sent yet (browser preconnect / proxy pool) -> exit 0 within 2 s", { timeout: 30_000 }, async () => {
    const proc = await api();
    const conn = await rawConnection(proc.port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await sigterm(proc, 2000);
    expect(result.code, proc.output().slice(-600)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
    expect(proc.output()).not.toContain("timed out");
    expect(await conn.closed).toBe("");
  });

  it("IDLE-03: a proxy reuses the idle keep-alive connection during shutdown (request started before the close) -> answer has Connection: close, exit 0 within 2 s", { timeout: 30_000 }, async () => {
    const proc = await api();
    const conn = await rawConnection(proc.port);
    conn.write(keepAliveGet("/healthz"));
    const first = await conn.response();
    expect(first).toMatch(/^HTTP\/1\.1 200/);
    expect(first.toLowerCase()).toContain("connection: keep-alive");
    // The next request on the same connection: its request line is on the wire when SIGTERM arrives, the rest after.
    const [line, ...rest] = keepAliveGet("/admin/api/agents").split("\r\n");
    conn.write(`${line}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exit = sigterm(proc, 2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    conn.write(rest.join("\r\n"));
    const second = await conn.response(first.length);
    expect(second).toMatch(/^HTTP\/1\.1 503/);
    expect(second.toLowerCase()).toContain("connection: close");
    expect((await conn.closed).length).toBe(first.length + second.length);
    const result = await exit;
    expect(result.code, proc.output().slice(-600)).toBe(0);
    expect(result.ms).toBeLessThan(2000);
  });

  it("IDLE-04: a proxy sends a request on an idle or never-used connection right after SIGTERM -> a Connection: close answer or a clean close with no response byte, exit 0 within 2 s", { timeout: 60_000 }, async () => {
    for (const used of [true, false]) {
      for (const delayMs of [0, 1, 5, 20]) {
        const proc = await api();
        const conn = await rawConnection(proc.port);
        let offset = 0;
        if (used) {
          conn.write(keepAliveGet("/healthz"));
          offset = (await conn.response()).length;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const exit = sigterm(proc, 2000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        conn.write(keepAliveGet("/admin/api/agents"));
        const answer = (await conn.closed).slice(offset);
        const what = `${used ? "idle" : "never-used"} connection, request ${delayMs} ms after SIGTERM`;
        // Never half a response: either nothing (the proxy retries on a fresh connection) or a full answer that closes.
        if (answer.length > 0) {
          expect(answer, what).toMatch(/^HTTP\/1\.1 \d{3}/);
          expect(answer.toLowerCase(), what).toContain("connection: close");
        }
        const result = await exit;
        expect(result.code, `${what}: ${proc.output().slice(-400)}`).toBe(0);
        expect(result.ms, what).toBeLessThan(2000);
      }
    }
  });
});
