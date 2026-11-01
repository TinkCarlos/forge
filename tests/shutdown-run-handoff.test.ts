import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execute, one, pool, query, repos } from "@forge/store";
import { cleanupStubEffects, ensureStubEffectsTable, hangingToolChildEnv, hangingToolNames, readCount, sideEffectCount, stubEffects } from "./helpers/hanging-tool.js";
import { expectHandoffMapping, type HandoffLine } from "./helpers/run-handoff.js";
import { freePort } from "./helpers/sse-client.js";
import { expectChildExit, expectParentBackstop, recordTiming, tail } from "./helpers/shutdown-assert.js";

// Ruling 15:39 with real child processes (*_test DB, free ports): the API (embedded worker) runs a Run whose tool
// call ignores the abort signal (tests/helpers/hanging-tool.ts). SIGTERM:
// - SH-01 the lease is not released before the API exits; run_handoff {takeover:"lease_expiry", reason:"tool_inflight"};
//   a standalone worker takes the Run over only after the API is gone; the side effect ran exactly once.
// - SH-02 worst case: the drain (hanging tool), the release (the Run's row is locked by this test) and the logger
//   flush (tests/helpers/preload-stuck-flush.mjs) all hang -> the process is gone before 9000 ms, no drain_timeout,
//   exit is the last phase line, exit code 1.
// - SH-03 the standalone worker: same release rule and run_handoff line.
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = join(ROOT_DIR, "tests", "helpers");
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `shh-${suffix}`;
const LEASE_TTL_SECONDS = 3;
const children: ChildProcess[] = [];
const stubKeys: string[] = [];
let modelServer: Server;
let modelPort = 0;
let providerId = "";
let agentId = "";
let versionId = "";

/** The stub model asks for the tool named in the Run's user message. */
function onModel(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  req.on("end", () => {
    const hasToolResult = body.includes('"role":"tool"');
    const tool = /"content":"(stub_[a-zA-Z0-9_-]+)"/.exec(body)?.[1] ?? "none";
    const message = hasToolResult
      ? { content: "done" }
      : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: "{}" } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
}

interface Child {
  child: ChildProcess;
  out: () => string;
  exited: Promise<{ code: number | null; at: number }>;
}

function spawnChild(entry: string, env: NodeJS.ProcessEnv, preloads: string[] = []): Child {
  const args = ["--import", "tsx", ...preloads.flatMap((file) => ["--import", pathToFileURL(join(HELPERS, file)).href]), entry];
  const child = spawn(process.execPath, args, { cwd: ROOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.once("exit", (code) => resolve({ code, at: Date.now() })));
  return { child, out: () => out, exited };
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, out?: () => string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n${out?.().slice(-1500) ?? ""}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function baseEnv(stubs: Array<{ key: string; hangMs: number }>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...hangingToolChildEnv(stubs),
    NODE_ENV: "test",
    WORKER_POLL_MS: "200",
    MAX_CONCURRENT_RUNS: "8",
    LEASE_TTL_SECONDS: String(LEASE_TTL_SECONDS),
    OUTBOUND_ALLOWLIST: `127.0.0.1:${modelPort}`,
  };
}

async function startApi(stubs: Array<{ key: string; hangMs: number }>, extra: NodeJS.ProcessEnv = {}, preloads: string[] = []): Promise<Child> {
  const port = await freePort();
  const api = spawnChild("apps/api/src/server.ts", { ...baseEnv(stubs), PORT: String(port), HOST: "127.0.0.1", EMBEDDED_WORKER: "true", LOG_LEVEL: "info", ...extra }, ["preload-signal-ready.mjs", ...preloads]);
  await waitFor("API listening", () => api.out().includes("Forge API listening") && api.out().includes("SIGTERM handler installed"), 30_000, api.out);
  return api;
}

async function newRun(tool: string): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: tool } });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: tool } });
  return runId;
}

const runRow = async (runId: string) =>
  (await one<{ status: string; claimed_by: string | null; expired: number | null }>("SELECT status, claimed_by, (lease_expires_at < UTC_TIMESTAMP(3)) AS expired FROM runs WHERE id = ?", [runId]))!;
const eventsOf = (runId: string, type: string) => query<{ data_json: unknown }>("SELECT data_json FROM run_events WHERE run_id = ? AND type = ? ORDER BY seq", [runId, type]);

type Phase = Partial<HandoffLine> & { phase: string; phaseSeq?: number; code?: number; runIds?: string[] };
const phaseLines = (text: string): Phase[] =>
  text.split("\n").filter((line) => line.startsWith("{") && line.includes('"phase"')).map((line) => JSON.parse(line) as Phase);

beforeAll(async () => {
  await ensureStubEffectsTable();
  modelServer = createServer(onModel);
  modelPort = await freePort();
  await new Promise<void>((resolve) => modelServer.listen(modelPort, "127.0.0.1", () => resolve()));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "SH model", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  agentId = await repos.createAgent({ key: `it-shh-${suffix}`, name: "IT SH", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [] }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
});

// A failed test must not leave a child behind that claims the next test's Run.
afterEach(async () => {
  const alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
  await Promise.all(alive.map((child) => new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); })));
  if (agentId) await execute("UPDATE runs SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL WHERE agent_id = ? AND status IN ('queued', 'running')", [agentId]);
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const key of stubKeys) await cleanupStubEffects(key);
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    for (const table of ["run_events", "run_steps", "messages", "approvals", "tool_calls"]) {
      await execute(`DELETE x FROM ${table} x JOIN runs r ON r.id = x.run_id WHERE r.agent_id = ?`, [agentId]);
    }
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
  await new Promise((resolve) => modelServer?.close(resolve));
});

describe("run handoff on shutdown (ruling 15:39, child processes)", () => {
  it("SH-01 API: a tool call that ignores abort -> lease not released before exit, run_handoff lease_expiry/tool_inflight; the worker takes over after the API exits; side effect once", async () => {
    const key = `sh1${suffix}`;
    stubKeys.push(key);
    const tool = hangingToolNames(key).effect;
    const api = await startApi([{ key, hangMs: 120_000 }], { WORKER_DRAIN_TIMEOUT_MS: "1000" });
    const runId = await newRun(tool);
    await waitFor("stub side effect started", async () => (await sideEffectCount(key)) === 1, 30_000, api.out);
    const apiOwner = (await runRow(runId)).claimed_by;
    expect(apiOwner).toMatch(new RegExp(`:${api.child.pid}(:|$)`));
    // A standalone worker polling all along: it may only get the Run once the API is gone and the lease expired.
    const worker = spawnChild("apps/worker/src/main.ts", baseEnv([{ key, hangMs: 120_000 }]));
    await waitFor("worker started", () => worker.out().includes("Forge worker started"), 30_000, worker.out);
    api.child.kill("SIGTERM");
    const { code } = await api.exited;
    const atExit = await runRow(runId);
    expect(atExit.claimed_by, api.out().slice(-1500)).toBe(apiOwner); // not released by the API, not taken yet
    expect(await eventsOf(runId, "run.released")).toEqual([]);
    expect(code).toBe(1);
    const phases = phaseLines(api.out());
    const handoffs = phases.filter((line) => line.phase === "run_handoff");
    expect(handoffs.map(({ runId: id, takeover, reason }) => ({ runId: id, takeover, reason }))).toEqual([{ runId, takeover: "lease_expiry", reason: "tool_inflight" }]);
    expectHandoffMapping(handoffs);
    const names = phases.map((line) => line.phase);
    expect(names.indexOf("run_drain_timeout")).toBeGreaterThan(-1);
    expect(names.indexOf("run_drain_timeout")).toBeLessThan(names.indexOf("run_handoff"));
    expect(names.indexOf("run_handoff")).toBeLessThan(names.indexOf("exit"));
    expect(names.at(-1)).toBe("exit");
    expect(names).not.toContain("drain_timeout");
    // The worker takes over after the lease expires (it was not released): run.resumed by the worker's id.
    await waitFor("worker took over", async () => {
      const row = await runRow(runId);
      return row.claimed_by !== apiOwner && (await eventsOf(runId, "run.resumed")).length > 0;
    }, (LEASE_TTL_SECONDS + 15) * 1000, worker.out);
    const raw = (await eventsOf(runId, "run.resumed"))[0]!.data_json;
    const resumed = (typeof raw === "string" ? JSON.parse(raw) : raw) as { workerId: string };
    expect(resumed.workerId).toMatch(new RegExp(`:${worker.child.pid}(:|$)`));
    // Side effects are not re-run on takeover: it ran once, in the API process.
    await waitFor("takeover settled", async () => (await runRow(runId)).status === "waiting_approval", 20_000, worker.out);
    expect(await sideEffectCount(key)).toBe(1);
    expect((await stubEffects(key)).map((row) => row.pid)).toEqual([api.child.pid]);
    worker.child.kill("SIGTERM");
    await worker.exited;
  }, 120_000);

  it("SH-02 API worst case: drain, release and flush all hang -> gone before 9000 ms, no drain_timeout, exit is the last phase line, code 1", async () => {
    const hangKey = `sh2h${suffix}`;
    const shortKey = `sh2s${suffix}`;
    stubKeys.push(hangKey, shortKey);
    // WORKER_DRAIN_TIMEOUT_MS default (35000): the API caps its Run drain at 5000.
    const api = await startApi([{ key: hangKey, hangMs: 120_000 }, { key: shortKey, hangMs: 1500 }], {}, ["preload-stuck-flush.mjs"]);
    const hung = await newRun(hangingToolNames(hangKey).effect); // the drain hangs: this tool ignores abort
    const locked = await newRun(hangingToolNames(shortKey).read); // the release hangs: tool ends, then its row is locked
    await waitFor("both tools started", async () => (await sideEffectCount(hangKey)) === 1 && (await readCount(shortKey)) === 1, 30_000, api.out);
    // r6 A19: taken before the kill (was after it, which made the parent's time too short); only the 12 s backstop.
    const sentAt = Date.now();
    api.child.kill("SIGTERM");
    // The short tool ends during the drain and its Run hands over; then lock its row so the release UPDATE waits.
    await waitFor("short tool result stored", async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ? AND status = 'succeeded'", [locked]))?.n === 1, 4000, api.out);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const conn = await pool.getConnection();
    let killed = 0;
    try {
      await conn.beginTransaction();
      await conn.execute("SELECT id FROM runs WHERE id = ? FOR UPDATE", [locked]);
      await waitFor("run_handoff lines", () => phaseLines(api.out()).filter((line) => line.phase === "run_handoff").length === 2, 8_000, api.out);
      // The API now closes its pool; the release statement still waiting on our lock (the run.released fence or the
      // lease UPDATE) would hold pool.end (not one of the three steps under test), so end that statement.
      const waiting = await query<{ id: number }>("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND COMMAND <> 'Sleep' AND INFO LIKE '%runs%' AND ID <> CONNECTION_ID()");
      for (const row of waiting) await execute(`KILL QUERY ${Number(row.id)}`);
      killed = waiting.length;
    } finally {
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
    const { code, at } = await api.exited;
    const tookMs = at - sentAt;
    expect(killed, tail(api.out(), 2000)).toBeGreaterThanOrEqual(1);
    expect(code, tail(api.out(), 2000)).toBe(1);
    // "gone before 9000 ms" (ruling 15:39) on the child's own clock: signal -> exit(1), after the stuck flush's cut.
    const call = expectChildExit(api.out(), { code: 1, maxMs: 9000 - 1 });
    recordTiming("SH-02", { exitCallMs: call.ms, parentMs: tookMs });
    expectParentBackstop(tookMs, api.out());
    const phases = phaseLines(api.out()).filter((line) => line.phase !== "flush_timeout");
    const order = [...phases].sort((a, b) => (a.phaseSeq ?? 0) - (b.phaseSeq ?? 0)).map((line) => line.phase);
    const out = tail(api.out(), 2000);
    expect(order, out).not.toContain("drain_timeout");
    expect(order.at(-1), out).toBe("exit");
    expect(phases.find((line) => line.phase === "exit"), out).toMatchObject({ code: 1 });
    expect(order.indexOf("run_drain_timeout"), out).toBeGreaterThan(-1);
    expect(order.indexOf("run_drain_timeout"), out).toBeLessThan(order.indexOf("release_timeout"));
    expect(order.indexOf("release_timeout"), out).toBeLessThan(order.indexOf("run_handoff"));
    const handoffs = phases.filter((line) => line.phase === "run_handoff");
    expectHandoffMapping(handoffs);
    expect(new Map(handoffs.map((line) => [line.runId, [line.takeover, line.reason]]))).toEqual(new Map([
      [hung, ["lease_expiry", "tool_inflight"]],
      [locked, ["lease_expiry", "release_timeout"]],
    ]));
    // The flush hung too: its timeout line (stderr, r4) is there.
    expect(api.out()).toContain('"phase":"flush_timeout"');
    for (const runId of [hung, locked]) await execute("UPDATE runs SET status = 'cancelled', claimed_by = NULL WHERE id = ?", [runId]);
  }, 60_000);

  it("SH-03 standalone worker: a tool call that ignores abort -> not released, run_handoff lease_expiry/tool_inflight after run_drain_timeout", async () => {
    const key = `sh3${suffix}`;
    stubKeys.push(key);
    const worker = spawnChild("apps/worker/src/main.ts", { ...baseEnv([{ key, hangMs: 120_000 }]), WORKER_DRAIN_TIMEOUT_MS: "800" });
    await waitFor("worker started", () => worker.out().includes("Forge worker started"), 30_000, worker.out);
    const runId = await newRun(hangingToolNames(key).effect);
    await waitFor("stub side effect started", async () => (await sideEffectCount(key)) === 1, 30_000, worker.out);
    const owner = (await runRow(runId)).claimed_by;
    worker.child.kill("SIGTERM");
    const { code } = await worker.exited;
    expect(code).toBe(1);
    expect((await runRow(runId)).claimed_by).toBe(owner);
    const lines = phaseLines(worker.out());
    const phases = lines.map((line) => line.phase);
    expect(phases).toEqual(["run_drain_timeout", "run_handoff"]); // the drain + 5 s hard stop (drain_timeout) never fired
    const handoffs = lines.filter((line) => line.phase === "run_handoff");
    expect(handoffs.map(({ runId: id, takeover, reason }) => ({ runId: id, takeover, reason }))).toEqual([{ runId, takeover: "lease_expiry", reason: "tool_inflight" }]);
    expectHandoffMapping(handoffs);
    await execute("UPDATE runs SET status = 'cancelled', claimed_by = NULL WHERE id = ?", [runId]);
  }, 60_000);
});
