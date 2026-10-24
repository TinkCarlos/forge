import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { executeRun } from "@forge/runtime";
import { execute, parseJsonValue, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1 SSE masking (needs a *_test DB). message.delta / message.completed are masked when they are written (the DB
// keeps no clear text), with the same function as run output; the SSE replay sends no message.delta for a completed
// message (only the masked full message); rows written before the fix are masked when read (no backfill, the stored
// legacy row stays as it is).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRETS = ["Hunter2Sekret", "abcDEF1234567890xyz", "sk-proj-Zz0123456789abcdefXY", "Pa55wOrdZ"];
const INPUT = `请记住 password=${SECRETS[0]} 和 Bearer ${SECRETS[1]} 以及 ${SECRETS[2]} 还有我的密码：${SECRETS[3]}，谢谢`;
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
const runs: string[] = [];

type Sse = { type: string; data: Record<string, unknown> };
async function readSse(runId: string): Promise<Sse[]> {
  const res = await app.inject({ method: "GET", url: `/admin/api/runs/${runId}/events`, headers });
  expect(res.statusCode).toBe(200);
  return res.body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Sse);
}
async function newRun(text: string, status?: string): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text }, status });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text } });
  runs.push(runId);
  return runId;
}
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s) || text.includes(s.slice(0, 8)));

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-ssem-${suffix}`, name: "IT ssem", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, status: "published", createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const id of runs) {
    const run = await repos.getRun(id);
    for (const table of ["run_events", "messages", "run_steps", "tool_calls"]) await execute(`DELETE FROM ${table} WHERE run_id = ?`, [id]);
    await execute("DELETE FROM runs WHERE id = ?", [id]);
    if (run?.thread_id) await execute("DELETE FROM threads WHERE id = ?", [run.thread_id]);
  }
  if (agentId) {
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("P1 message events are masked like REST", () => {
  let runId = "";
  it("runtime writes masked message.delta / message.completed (no clear text in run_events)", async () => {
    runId = await newRun(INPUT);
    await executeRun(runId);
    const events = await repos.listEvents(runId, 0);
    const deltas = events.filter((e) => e.type === "message.delta").map((e) => parseJsonValue<{ delta: string }>(e.data_json, { delta: "" }).delta);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const joined = deltas.join("");
    expect(leaks(joined)).toEqual([]);
    for (const d of deltas) for (const run of d.match(/\*+/g) ?? []) expect(run.length % 3).toBe(0);
    const completed = events.filter((e) => e.type === "message.completed").map((e) => parseJsonValue<{ text: string }>(e.data_json, { text: "" }).text);
    expect(completed).toHaveLength(1);
    expect(leaks(completed[0]!)).toEqual([]);
    expect(completed[0]).toContain("password=***");
    expect(completed[0]).toContain("我的密码：***");
    expect(joined).toBe(completed[0]);
    const raw = events.map((e) => JSON.stringify(e.data_json)).join("\n");
    expect(leaks(raw)).toEqual([]);
  });

  it("SSE replay of a completed message: no message.delta, masked message.completed", async () => {
    const events = await readSse(runId);
    expect(events.filter((e) => e.type === "message.delta")).toEqual([]);
    const completed = events.filter((e) => e.type === "message.completed");
    expect(completed).toHaveLength(1);
    expect(leaks(JSON.stringify(events))).toEqual([]);
  });

  it("legacy rows written before the fix (clear text) are masked when read; the stored row is untouched", async () => {
    const legacy = await newRun("legacy", "succeeded");
    const clear = `old password=${SECRETS[0]} and Bearer ${SECRETS[1]}`;
    await repos.addEvent(legacy, "message.delta", { delta: clear.slice(0, 20) });
    await repos.addEvent(legacy, "message.delta", { delta: clear.slice(20) });
    await repos.addEvent(legacy, "message.completed", { text: clear, usage: { inputTokens: 1, outputTokens: 2 } });
    await repos.addEvent(legacy, "message.delta", { delta: `dangling token=${SECRETS[3]} ` });
    const events = await readSse(legacy);
    expect(leaks(JSON.stringify(events))).toEqual([]);
    const completed = events.find((e) => e.type === "message.completed")!;
    expect(completed.data).toEqual({ text: "old password=*** and Bearer ***", usage: { inputTokens: 1, outputTokens: 2 } });
    expect(events.filter((e) => e.type === "message.delta")).toHaveLength(1); // the dangling one (no completion after it), masked
    const stored = (await repos.listEvents(legacy, 0)).find((e) => e.type === "message.completed")!;
    expect(parseJsonValue<{ text: string }>(stored.data_json, { text: "" }).text).toBe(clear);
  });

  it("the 'delta is deliberately not masked' comment is gone from http-helpers.ts", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "apps", "api", "src", "plugins", "http-helpers.ts"), "utf8");
    expect(src).not.toMatch(/message\.delta fragments must not be/);
  });
});
