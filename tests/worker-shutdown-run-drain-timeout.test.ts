import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, one, repos } from "@forge/store";
import { expectHandoffMapping } from "./helpers/run-handoff.js";
import { freePort } from "./helpers/sse-client.js";

// Architect ruling 15:17 (1): the standalone worker (real child process) gets SIGTERM while a tool call it runs never
// answers. The Run drain runs out of WORKER_DRAIN_TIMEOUT_MS -> one line phase=run_drain_timeout with runIds and
// drainMs, then the normal close (pool end) and exit 1. The process backstop at drain + 5 s (phase=drain_timeout) is
// not reached. The aborted Run's lease is released (best effort), so another worker can claim it at once.
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `wsd-${suffix}`;
const SOURCE_KEY = `wsd-${suffix}`;
const PEEK = `openapi_${SOURCE_KEY}_peek`.replace(/[^a-zA-Z0-9_-]/g, "_"); // GET /p, read-only, risk low
const DRAIN_MS = 1500;

let agentId = "";
let versionId = "";
let providerId = "";
let sourceId = "";
let modelServer: Server;
let downServer: Server;
let modelPort = 0;
let downPort = 0;
const children: ChildProcess[] = [];
const held: ServerResponse[] = [];
let arrived: () => void = () => undefined;

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function onModel(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: PEEK, arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
}

function onDown(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  held.push(res); // never answered: the tool call stays in flight
  arrived();
}

type Line = { phase?: string; runIds?: string[]; drainMs?: number; code?: number; runId?: string; takeover?: string; reason?: string };

beforeAll(async () => {
  modelServer = createServer(onModel);
  downServer = createServer(onDown);
  modelPort = await freePort();
  await listen(modelServer, modelPort);
  downPort = await freePort();
  await listen(downServer, downPort);
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "WSD model", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  sourceId = await repos.createToolSource({ key: SOURCE_KEY, name: "wsd", baseUrl: `http://127.0.0.1:${downPort}`, spec: { paths: {} } });
  await repos.replaceTools(sourceId, [{ name: "peek", operationId: "peek", method: "GET", path: "/p", readOnly: true, risk: "low" }]);
  agentId = await repos.createAgent({ key: `it-wsd-${suffix}`, name: "IT WSD", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
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
  await new Promise((resolve) => modelServer?.close(resolve));
  downServer?.closeAllConnections?.();
  await new Promise((resolve) => downServer?.close(resolve));
});

describe("standalone worker: Run drain timeout on SIGTERM", () => {
  it("logs run_drain_timeout {runIds, drainMs}, closes normally and exits 1; no drain_timeout backstop; lease released", async () => {
    const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" } });
    const inFlight = new Promise<void>((resolve) => (arrived = resolve));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      WORKER_DRAIN_TIMEOUT_MS: String(DRAIN_MS),
      WORKER_POLL_MS: "200",
      MAX_CONCURRENT_RUNS: "8",
      OUTBOUND_ALLOWLIST: `127.0.0.1:${modelPort},127.0.0.1:${downPort}`,
    };
    const child = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/main.ts"], { cwd: ROOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await Promise.race([inFlight, new Promise((_, reject) => setTimeout(() => reject(new Error(`tool request never reached downstream\n${out}`)), 25_000))]);
    expect((await one<{ claimed_by: string | null }>("SELECT claimed_by FROM runs WHERE id = ?", [runId]))!.claimed_by).toMatch(new RegExp(`:${child.pid}$`));
    const signalledAt = Date.now();
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`worker did not exit\n${out}`)), DRAIN_MS + 10_000))]);
    const tookMs = Date.now() - signalledAt;
    const lines: Line[] = out.split("\n").filter((line) => line.startsWith("{")).map((line) => { try { return JSON.parse(line) as Line; } catch { return {}; } });
    const phases = lines.map((line) => line.phase).filter(Boolean);
    expect(code).toBe(1);
    // The drain + 5 s backstop (drain_timeout) never fired. Ruling 15:39: then one run_handoff line per Run.
    expect(phases).toEqual(["run_drain_timeout", "run_handoff"]);
    const timeout = lines.find((line) => line.phase === "run_drain_timeout")!;
    expect(timeout.runIds).toContain(runId);
    expect(timeout.drainMs).toBeGreaterThanOrEqual(DRAIN_MS);
    expect(tookMs).toBeLessThan(DRAIN_MS + 5000);
    const after = (await one<{ status: string; claimed_by: string | null }>("SELECT status, claimed_by FROM runs WHERE id = ?", [runId]))!;
    expect(after).toEqual({ status: "running", claimed_by: null }); // released: claimable at once by the next poll
    // The web tool honours the abort: its call ended, so the lease was released (drained -> released).
    const handoffs = lines.filter((line) => line.phase === "run_handoff");
    expect(handoffs.map(({ runId: id, takeover, reason }) => ({ runId: id, takeover, reason }))).toEqual([{ runId, takeover: "released", reason: "drained" }]);
    expectHandoffMapping(handoffs as never);
  }, 60_000);
});
