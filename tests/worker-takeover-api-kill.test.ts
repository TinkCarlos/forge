import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { config } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { claimRun, runClaimed } from "@forge/runtime";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";
import { freePort } from "./helpers/sse-client.js";

// TK-13K (architect ruling, front-end observation 1): after an approval is decided, the tool call runs in the API
// process (POST /admin/api/approvals/:id/decide -> executeRun, claimed_by = the API's hostname:pid). The API process is
// SIGKILLed while that tool call is in flight (a real child process). Once its lease expires a worker takes the Run
// over and follows the takeover rules: read-only -> re-run in place (attempt 2); side effects -> not re-run, a new
// `interrupted` approval. Nothing is stubbed in the child: the model and the downstream API are local HTTP servers in
// this test process, reachable through OUTBOUND_ALLOWLIST (exact host:port).
// Named TK-13K: TK-13 is already the grace-boundary case in tests/worker-takeover.test.ts.
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `tk13k-${suffix}`;
const SOURCE_KEY = `tk13k-${suffix}`;
const SEND = `openapi_${SOURCE_KEY}_send`.replace(/[^a-zA-Z0-9_-]/g, "_"); // POST /s, side effects, risk high
const PEEK = `openapi_${SOURCE_KEY}_peek`.replace(/[^a-zA-Z0-9_-]/g, "_"); // GET /p, read-only, risk high
const CHILD_LEASE_TTL_SECONDS = 3;
const cfg = config as unknown as Record<string, unknown>;
const savedAllowlist = cfg.OUTBOUND_ALLOWLIST;

let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let providerId = "";
let sourceId = "";
let modelServer: Server;
let downServer: Server;
let modelPort = 0;
let downPort = 0;
const children: ChildProcess[] = [];

/** Downstream requests by path; while `hold` is set the next request is never answered (the call stays in flight). */
const hits: Record<string, number> = {};
let hold: { resolve: () => void } | null = null;
const held: ServerResponse[] = [];

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function onModel(_req: IncomingMessage, res: ServerResponse): void {
  _req.resume();
  _req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
}

function onDown(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  req.resume();
  if (hold) {
    const pending = hold;
    hold = null;
    held.push(res);
    pending.resolve();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("downstream ok");
}

async function startApiChild(): Promise<{ child: ChildProcess; port: number; exited: Promise<unknown> }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    HOST: "127.0.0.1",
    EMBEDDED_WORKER: "false",
    LOG_LEVEL: "warn",
    LEASE_TTL_SECONDS: String(CHILD_LEASE_TTL_SECONDS),
    OUTBOUND_ALLOWLIST: `127.0.0.1:${modelPort},127.0.0.1:${downPort}`,
  };
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], { cwd: ROOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const started = Date.now();
  while (!out.includes("Forge API listening")) {
    if (child.exitCode !== null) throw new Error(`API child exited during startup (code ${child.exitCode})`);
    if (Date.now() - started > 30_000) {
      child.kill("SIGKILL");
      throw new Error("API child did not start in 30 s");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, port, exited };
}

type RunState = { status: string; claimed_by: string | null; lease_expires_at: Date | null; expired: number };
const runState = async (runId: string) =>
  (await one<RunState>("SELECT status, claimed_by, lease_expires_at, (lease_expires_at < UTC_TIMESTAMP(3)) AS expired FROM runs WHERE id = ?", [runId]))!;
const toolRow = async (rowId: string) =>
  (await one<{ status: string; attempt: number; approval_id: string | null }>("SELECT status, attempt, approval_id FROM tool_calls WHERE id = ?", [rowId]))!;
const approvalsOf = (runId: string) => query<{ id: string; status: string; reason: string }>("SELECT id, status, reason FROM approvals WHERE run_id = ? ORDER BY created_at, id", [runId]);

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A Run waiting on a pending policy approval for one tool call (what the loop leaves behind at approval.required). */
async function seedWaiting(toolKey: string, readOnly: boolean): Promise<{ runId: string; rowId: string; approvalId: string }> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status: "waiting_approval" });
  const rowId = await repos.addToolCall({ runId, toolKey, args: {}, risk: "high", status: "pending", idempotencyKey: `${runId}:s1:0`, attempt: 1, readOnly, modelStep: 1, stepIndex: 0 });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: "go" } });
  await repos.addMessage({ threadId, runId, seq: 2, role: "assistant", content: { text: "", tool_calls: [{ id: rowId, type: "function", function: { name: toolKey, arguments: "{}" } }] } });
  const approval = await repos.addApproval({ runId, toolCallId: rowId, risk: "high", timeoutSeconds: 3600 });
  return { runId, rowId, approvalId: approval.id };
}

/**
 * Decide in the API child, wait until the tool request is in flight downstream (held), check the Run is held by the
 * child, SIGKILL the child, wait for the lease to expire, then take over the way a worker does.
 */
async function killApiMidTool(toolKey: string, readOnly: boolean, path: string): Promise<{ runId: string; rowId: string; approvalId: string; childId: string }> {
  const seeded = await seedWaiting(toolKey, readOnly);
  const api = await startApiChild();
  const arrived = new Promise<void>((resolve) => (hold = { resolve }));
  const res = await fetch(`http://127.0.0.1:${api.port}/admin/api/approvals/${seeded.approvalId}/decide`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  expect(res.status).toBe(200);
  await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error("tool request never reached downstream")), 20_000))]);
  expect(hits[path]).toBe(1);
  const during = await runState(seeded.runId);
  expect(during.status).toBe("running");
  expect(during.claimed_by).toMatch(new RegExp(`:${api.child.pid}:[0-9a-f]{8}$`)); // executed in the API process (hostname:pid:epoch)
  expect((await toolRow(seeded.rowId)).status).toBe("running");
  api.child.kill("SIGKILL");
  await api.exited;
  for (const response of held.splice(0)) response.destroy();
  // Before expiry nobody may take it; after expiry it is claimable by any worker (same predicate as claimNextRun).
  expect(await claimRun(seeded.runId, `w-early-${suffix}`, false)).toBeNull();
  await waitFor("lease expiry", async () => Number((await runState(seeded.runId)).expired) === 1, (CHILD_LEASE_TTL_SECONDS + 5) * 1000);
  const stuck = await runState(seeded.runId);
  expect(stuck).toMatchObject({ status: "running", claimed_by: during.claimed_by });
  const workerId = `w-taker-${suffix}`;
  const claimable = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM runs WHERE id = ? AND (status = 'queued' OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3))))",
    [seeded.runId],
  );
  expect(Number(claimable?.n)).toBe(1);
  const claimed = await claimRun(seeded.runId, workerId, false);
  expect(claimed).not.toBeNull();
  await runClaimed(claimed!, workerId);
  return { ...seeded, childId: during.claimed_by! };
}

beforeAll(async () => {
  modelServer = createServer(onModel);
  downServer = createServer(onDown);
  modelPort = await freePort();
  await listen(modelServer, modelPort);
  downPort = await freePort();
  await listen(downServer, downPort);
  cfg.OUTBOUND_ALLOWLIST = `127.0.0.1:${modelPort},127.0.0.1:${downPort}`;
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "TK13K model", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  sourceId = await repos.createToolSource({ key: SOURCE_KEY, name: "tk13k", baseUrl: `http://127.0.0.1:${downPort}`, spec: { paths: {} } });
  await repos.replaceTools(sourceId, [
    { name: "send", operationId: "send", method: "POST", path: "/s", readOnly: false, risk: "high" },
    { name: "peek", operationId: "peek", method: "GET", path: "/p", readOnly: true, risk: "high" },
  ]);
  agentId = await repos.createAgent({ key: `it-tk13k-${suffix}`, name: "IT TK13K", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "x",
    spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [{ openapi: SOURCE_KEY }] },
    status: "published",
    createdBy: ADMIN_ID,
  });
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const response of held.splice(0)) response.destroy();
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE e FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE s FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE m FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE p FROM approvals p JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE t FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (sourceId) {
    await execute("DELETE FROM tools WHERE source_id = ?", [sourceId]);
    await execute("DELETE FROM tool_sources WHERE id = ?", [sourceId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
  await cleanupRealSessions();
  await app?.close();
  cfg.OUTBOUND_ALLOWLIST = savedAllowlist;
  await new Promise((resolve) => modelServer?.close(resolve));
  downServer?.closeAllConnections?.();
  await new Promise((resolve) => downServer?.close(resolve));
});

describe("TK-13K the API process is killed while it executes an approved tool call", () => {
  it("side effects: after the lease expires a worker takes over, does not re-run it, asks again (interrupted); approved -> runs once more, Run succeeded", async () => {
    const { runId, rowId, approvalId } = await killApiMidTool(SEND, false, "/s");
    expect(hits["/s"]).toBe(1); // not re-run by the takeover
    expect(await toolRow(rowId)).toMatchObject({ status: "pending_approval" });
    const list = await approvalsOf(runId);
    expect(list.map((a) => [a.id === approvalId ? "old" : "new", a.status, a.reason])).toEqual([["old", "approved", "policy"], ["new", "pending", "interrupted"]]);
    expect(await runState(runId)).toMatchObject({ status: "waiting_approval", claimed_by: null });
    const fresh = list.find((a) => a.id !== approvalId)!;
    const res = await app.inject({ method: "POST", url: `/admin/api/approvals/${fresh.id}/decide`, headers, payload: { decision: "approved" } });
    expect(res.statusCode).toBe(200);
    await waitFor("Run succeeded", async () => (await runState(runId)).status === "succeeded", 20_000);
    expect(hits["/s"]).toBe(2);
    expect(await toolRow(rowId)).toMatchObject({ status: "succeeded", attempt: 2 });
  }, 90_000);

  it("read-only: after the lease expires a worker takes over and re-runs it in place (attempt 2), Run succeeded", async () => {
    const { runId, rowId } = await killApiMidTool(PEEK, true, "/p");
    expect(hits["/p"]).toBe(2);
    expect(await toolRow(rowId)).toMatchObject({ status: "succeeded", attempt: 2 });
    expect((await runState(runId)).status).toBe("succeeded");
    expect(await approvalsOf(runId)).toHaveLength(1);
  }, 90_000);
});
