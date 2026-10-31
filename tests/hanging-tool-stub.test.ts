import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, one, repos } from "@forge/store";
import { cleanupStubEffects, ensureStubEffectsTable, hangingToolChildEnv, hangingToolNames, hangingTools, readCount, sideEffectCount, stubEffects } from "./helpers/hanging-tool.js";
import { freePort } from "./helpers/sse-client.js";

// Self-test of tests/helpers/hanging-tool.ts (the tool stub that ignores the abort signal), in-process and in a real
// worker child process (hangingToolChildEnv).
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const KEY_IN = `hin${suffix}`;
const KEY_CHILD = `hch${suffix}`;
const PROVIDER_KEY = `hts-${suffix}`;
const children: ChildProcess[] = [];
let modelServer: Server;
let modelPort = 0;
let providerId = "";
let agentId = "";
let versionId = "";

function onModel(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  req.on("end", () => {
    const hasToolResult = body.includes('"role":"tool"');
    const message = hasToolResult
      ? { content: "done" }
      : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: hangingToolNames(KEY_CHILD).effect, arguments: "{}" } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
}

beforeAll(async () => {
  await ensureStubEffectsTable();
  modelServer = createServer(onModel);
  modelPort = await freePort();
  await new Promise<void>((resolve) => modelServer.listen(modelPort, "127.0.0.1", () => resolve()));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "HTS model", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  agentId = await repos.createAgent({ key: `it-hts-${suffix}`, name: "IT HTS", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [] }, status: "published", createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await cleanupStubEffects(KEY_IN);
  await cleanupStubEffects(KEY_CHILD);
  if (agentId) {
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

describe("hanging tool stub (ignores abort)", () => {
  it("in-process: an aborted signal does not end the call early; effect counted once per execution, read separately", async () => {
    const tools = hangingTools({ key: KEY_IN, hangMs: 300 });
    const names = hangingToolNames(KEY_IN);
    expect(tools.get(names.effect)?.readOnly).toBe(false);
    expect(tools.get(names.read)?.readOnly).toBe(true);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = tools.get(names.effect)!.execute({}, { signal: controller.signal, idempotencyKey: "k1" });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: true });
    // r6 A19: the stub's 300 ms hang despite the abort; configured value - 1 (a timer can fire 1 ms early on Date.now).
    const tookMs = Date.now() - startedAt;
    expect(tookMs, `took ${tookMs} ms`).toBeGreaterThanOrEqual(300 - 1);
    expect(await sideEffectCount(KEY_IN)).toBe(1);
    await tools.get(names.read)!.execute({}, { signal: AbortSignal.abort() });
    expect(await sideEffectCount(KEY_IN)).toBe(1);
    expect(await readCount(KEY_IN)).toBe(1);
    expect((await stubEffects(KEY_IN)).map((row) => [row.kind, row.idempotency_key, row.pid])).toEqual([["effect", "k1", process.pid], ["read", null, process.pid]]);
  });

  it("child process: a worker started with hangingToolChildEnv resolves the stub and runs it (counted with the child's pid)", async () => {
    const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" } });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...hangingToolChildEnv({ key: KEY_CHILD, hangMs: 200 }),
      NODE_ENV: "test",
      WORKER_POLL_MS: "200",
      MAX_CONCURRENT_RUNS: "8",
      OUTBOUND_ALLOWLIST: `127.0.0.1:${modelPort}`,
    };
    const child = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/main.ts"], { cwd: ROOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const started = Date.now();
    for (;;) {
      const run = await one<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]);
      if (run?.status === "succeeded") break;
      if (Date.now() - started > 30_000) throw new Error(`Run not succeeded (${run?.status})\n${out}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill("SIGTERM");
    await exited;
    expect(await sideEffectCount(KEY_CHILD)).toBe(1);
    const rows = await stubEffects(KEY_CHILD);
    expect(rows.map((row) => [row.kind, row.tool, row.pid])).toEqual([["effect", hangingToolNames(KEY_CHILD).effect, child.pid]]);
    expect(rows[0]!.idempotency_key).toBeTruthy(); // the runtime passes the call's downstream key
  }, 60_000);
});
