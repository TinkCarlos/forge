import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { executeRun } from "@forge/runtime";
import { execute, parseJsonValue, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1 SSE (architect ruling, needs a *_test DB): the worker no longer writes or sends message.delta; only the masked
// message.completed and the run.* events are stored and sent. When events are read, message.delta rows already in
// the DB are filtered out and every other event goes through the run-output mask (maskArgsDeep) again; no backfill,
// nothing deleted. Same for the admin and the open event streams (both use streamRun). Assertions are on the event
// data (SSE JSON and run_events rows), not on log text.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRETS = ["Hunter2Sekret", "abcDEF1234567890xyz", "sk-proj-Zz0123456789abcdefXY", "Pa55wOrdZ"];
const INPUT = `请记住 password=${SECRETS[0]} 和 Bearer ${SECRETS[1]} 以及 ${SECRETS[2]} 还有我的密码：${SECRETS[3]}，谢谢`;
let app: FastifyInstance;
let adminHeaders: Record<string, string> = {};
let openKey = "";
let agentId = "";
let versionId = "";
let appId = "";
const runs: string[] = [];

type Sse = { type: string; data: Record<string, unknown> };
const streams: Array<[string, () => Record<string, string>, string]> = [
  ["admin", () => adminHeaders, "/admin/api/runs/{id}/events"],
  ["open", () => ({ authorization: `Bearer ${openKey}` }), "/open/v1/runs/{id}/events"],
];
async function readSse(headers: Record<string, string>, url: string, runId: string): Promise<Sse[]> {
  const res = await app.inject({ method: "GET", url: url.replace("{id}", runId), headers });
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  return res.body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Sse);
}
async function newRun(text: string, status?: string): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, appId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text } });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text } });
  if(status)await repos.updateRun(runId,{status});
  runs.push(runId);
  return runId;
}
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s) || text.includes(s.slice(0, 8)));

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  adminHeaders = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-ssem-${suffix}`, name: "IT ssem", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  appId = await repos.createApiApp({ key: `it-ssem-${suffix}`, name: "IT ssem", ownerOrgUnitId: ROOT, scopes: ["runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:read"] });
});

afterAll(async () => {
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
  await app?.close();
});

describe("P1 message events: no delta, masked completed", () => {
  let liveRun = "";
  let legacyRun = "";
  const legacyClear = `old password=${SECRETS[0]} and Bearer ${SECRETS[1]}`;

  beforeAll(async () => {
    liveRun = await newRun(INPUT);
    await executeRun(liveRun);
    legacyRun = await newRun("legacy", "succeeded");
    // Rows as written before the fix: clear text, deltas present.
    await repos.addEvent(legacyRun, "message.delta", { delta: legacyClear.slice(0, 20) });
    await repos.addEvent(legacyRun, "message.delta", { delta: legacyClear.slice(20) });
    await repos.addEvent(legacyRun, "message.completed", { text: legacyClear, usage: { inputTokens: 1, outputTokens: 2 } });
    await repos.addEvent(legacyRun, "message.delta", { delta: `dangling token=${SECRETS[3]} ` });
  });

  it("(a) the worker writes no message.delta row and the run's events hold no clear text", async () => {
    const events = await repos.listEvents(liveRun, 0);
    expect(events.map((e) => e.type)).not.toContain("message.delta");
    expect(events.map((e) => e.type)).toContain("message.completed");
    expect(leaks(events.map((e) => JSON.stringify(e.data_json)).join("\n"))).toEqual([]);
  });

  it("(b) the stored message.completed is masked", async () => {
    const row = (await repos.listEvents(liveRun, 0)).find((e) => e.type === "message.completed")!;
    const text = parseJsonValue<{ text: string }>(row.data_json, { text: "" }).text;
    expect(text).toContain("password=***");
    expect(text).toContain("我的密码：***");
    expect(leaks(text)).toEqual([]);
  });

  it.each(streams)("(a)(b) %s SSE: no message.delta, masked message.completed", async (_n, headers, url) => {
    const events = await readSse(headers(), url, liveRun);
    expect(events.map((e) => e.type)).not.toContain("message.delta");
    const completed = events.filter((e) => e.type === "message.completed");
    expect(completed).toHaveLength(1);
    expect(String(completed[0]!.data.text)).toContain("password=***");
    expect(leaks(JSON.stringify(events))).toEqual([]);
  });

  it.each(streams)("(c) %s SSE: legacy clear-text message.delta rows are not sent", async (_n, headers, url) => {
    const events = await readSse(headers(), url, legacyRun);
    expect(events.map((e) => e.type)).not.toContain("message.delta");
    expect(leaks(JSON.stringify(events))).toEqual([]);
  });

  it.each(streams)("(d) %s SSE: a legacy clear-text message.completed is sent masked; the stored row is untouched", async (_n, headers, url) => {
    const events = await readSse(headers(), url, legacyRun);
    const completed = events.filter((e) => e.type === "message.completed");
    expect(completed.map((e) => e.data)).toEqual([{ text: "old password=*** and Bearer ***", usage: { inputTokens: 1, outputTokens: 2 } }]);
    const stored = (await repos.listEvents(legacyRun, 0)).filter((e) => e.type.startsWith("message."));
    expect(stored).toHaveLength(4);
    expect(parseJsonValue<{ text: string }>(stored[2]!.data_json, { text: "" }).text).toBe(legacyClear);
  });

  it("the 'delta is deliberately not masked' comment is gone from http-helpers.ts", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "apps", "api", "src", "plugins", "http-helpers.ts"), "utf8");
    expect(src).not.toMatch(/message\.delta fragments must not be/);
  });
});
