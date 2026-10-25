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
});
