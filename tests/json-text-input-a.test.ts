import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { storedJsonValue } from "@forge/core";
import { sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { jsonBody } from "../apps/api/src/plugins/http-helpers.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item A (needs a *_test DB): input / manifest / resources / capabilities follow the bd4facf rules for spec / headers.
// Request: JSON text that does not parse (or parses to the wrong shape) is 400 CFG-8501 with details.field, nothing
// written. Stored: a value that is not the expected shape is treated as {} ([] for the capabilities array) and logged as
// one warning naming table, column and id only.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const k = (tag: string): string => `it-jta-${tag}-${suffix}`;
const LEAK = `{"password":"leak-${suffix}"`; // truncated: invalid JSON
let app: FastifyInstance;
let session: Session;
let headers: Record<string, string> = {};
let agentId = "";
let providerId = "";
let modelId = "";

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await realSession({ name: "IT jta", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  agentId = await repos.createAgent({ key: k("agent"), name: "IT jta", ownerOrgUnitId: ROOT, createdBy: session.principal.id });
  const versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: session.principal.id }, { expectedRevision: "system" });
  await repos.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  providerId = await repos.createProvider({ key: k("prov"), name: "IT jta", protocol: "mock", baseUrl: "https://llm.example.com/v1", apiKeyEncrypted: null, headers: {}, timeoutMs: 120000, createdBy: session.principal.id });
  modelId = await repos.createModel({ providerId, key: "m1", displayName: "m1", capabilities: ["text"] });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await execute("DELETE e FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ?", [agentId]);
  await execute("DELETE m FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.agent_id = ?", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
  await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  await execute("DELETE FROM plugins WHERE `key` LIKE ?", [`it-jta-%-${suffix}`]);
  await cleanupRealSessions();
  await app.close();
});

const send = (method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers, payload });
const expect400 = (res: { statusCode: number; body: string; json: () => unknown }, field: string) => {
  expect(res.statusCode, res.body).toBe(400);
  const error = (res.json() as { error: { code: string; details?: { field?: string } } }).error;
  expect(error.code).toBe("CFG-8501");
  expect(error.details?.field).toBe(field);
};
const caught = (fn: () => unknown): { code?: string; httpStatus?: number; details?: { field?: string } } => {
  try {
    fn();
  } catch (error) {
    return error as never;
  }
  throw new Error("expected a throw");
};

describe("jsonBody: JSON text must parse to the field's shape", () => {
  it.each([
    ["object", ["{bad", "[1]", "\"x\"", "42", "null"]],
    ["stringArray", ["{bad", "{}", "[1]", "\"x\"", "null"]],
    ["objectOrArray", ["{bad", "\"x\"", "42", "null"]],
  ] as const)("%s rejects %j with 400 CFG-8501 details.field", (shape, bads) => {
    for (const bad of bads) {
      const error = caught(() => jsonBody({ f: bad }, "f", {}, shape));
      expect([error.code, error.httpStatus, error.details?.field], `${shape} ${bad}`).toEqual(["CFG-8501", 400, "f"]);
    }
  });
  it("valid text is parsed, non-string values pass through, missing -> fallback", () => {
    expect(jsonBody({ f: "{\"a\":1}" }, "f", {}, "object")).toEqual({ a: 1 });
    expect(jsonBody({ f: "[\"text\"]" }, "f", [], "stringArray")).toEqual(["text"]);
    expect(jsonBody({ f: "[1,2]" }, "f", {}, "objectOrArray")).toEqual([1, 2]);
    expect(jsonBody({ f: { a: 1 } }, "f", {}, "object")).toEqual({ a: 1 });
    expect(jsonBody({}, "f", ["x"], "stringArray")).toEqual(["x"]);
  });
});

describe("requests with invalid JSON text -> 400, nothing written", () => {
  it.each(["{bad", "\"x\""])("POST /agents/:id/run input=%j", async (bad) => {
    const before = await query("SELECT id FROM runs WHERE agent_id = ?", [agentId]);
    expect400(await send("POST", `/admin/api/agents/${agentId}/run`, { input: bad }), "input");
    expect(await query("SELECT id FROM runs WHERE agent_id = ?", [agentId])).toHaveLength(before.length);
  });
  it.each(["{bad", "[1]", "{}"])("model capabilities=%j on create and patch", async (bad) => {
    expect400(await send("POST", `/admin/api/providers/${providerId}/models`, { key: k("m2"), displayName: "m2", capabilities: bad }), "capabilities");
    expect(await query("SELECT id FROM llm_models WHERE provider_id = ? AND `key` = ?", [providerId, k("m2")])).toHaveLength(0);
    expect400(await send("PATCH", `/admin/api/models/${modelId}`, { capabilities: bad }), "capabilities");
    expect((await query<{ c: unknown }>("SELECT capabilities_json AS c FROM llm_models WHERE id = ?", [modelId]))[0]!.c).toEqual(["text"]);
  });
  it.each([
    ["manifest", { manifest: "{bad" }],
    ["manifest", { manifest: "[1]" }],
    ["capabilities", { resources: { providers: [{ key: k("pp"), baseUrl: "https://llm.example.com/v1", models: [{ key: "x", capabilities: "{bad" }] }] } }],
  ] as const)("plugin install %s -> 400, no plugin row", async (field, extra) => {
    const key = k(`pl-${field}`);
    expect400(await send("POST", "/admin/api/plugins/install", { key, ...extra }), field);
    expect(await query("SELECT id FROM plugins WHERE `key` = ?", [key])).toHaveLength(0);
    expect(await query("SELECT id FROM llm_providers WHERE `key` = ?", [k("pp")])).toHaveLength(0);
  });
  it("plugin install resources as JSON text -> 400", async () => {
    const key = k("pl-res");
    const res = await send("POST", "/admin/api/plugins/install", { key, resources: "{bad" });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("CFG-8501");
    expect(await query("SELECT id FROM plugins WHERE `key` = ?", [key])).toHaveLength(0);
  });
});

describe("stored values of the wrong shape are {} / [] with one id-only warning", () => {
  const warned = (spy: { mock: { calls: unknown[][] } }, column: string) => spy.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes(column));

  it("storedJsonValue", () => {
    const warn = vi.fn();
    const ref = { table: "t", column: "c", id: "rec-1" };
    expect(storedJsonValue([1], ref, "objectOrArray", warn)).toEqual([1]);
    expect(storedJsonValue("[\"a\"]", ref, "stringArray", warn)).toEqual(["a"]);
    expect(storedJsonValue(null, ref, "stringArray", warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(storedJsonValue(LEAK, ref, "objectOrArray", warn)).toEqual({});
    expect(storedJsonValue(LEAK, ref, "stringArray", warn)).toEqual([]);
    expect(storedJsonValue([1], ref, "stringArray", warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("leak-");
  });

  it("llm_models.capabilities_json -> [] in the provider list", async () => {
    await execute("UPDATE llm_models SET capabilities_json = JSON_QUOTE(?) WHERE id = ?", [LEAK, modelId]);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.inject({ method: "GET", url: "/admin/api/providers", headers });
    expect(res.statusCode, res.body).toBe(200);
    const provider = (res.json() as { items: Array<{ id: string; models: Array<{ id: string; capabilities: unknown }> }> }).items.find((p) => p.id === providerId)!;
    expect(provider.models.find((m) => m.id === modelId)!.capabilities).toEqual([]);
    const lines = warned(spy, "capabilities_json");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(modelId);
    expect(lines[0]).not.toContain("leak-");
    await execute("UPDATE llm_models SET capabilities_json = ? WHERE id = ?", [JSON.stringify(["text"]), modelId]);
  });

  it("runs.input_json -> {} in the run detail", async () => {
    const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: session.principal.id });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: (await repos.getAgent(agentId))!.published_version_id!, orgUnitId: ROOT, subjectType: "user", subjectId: session.principal.id, input: { text: "hi" } });
    await execute("UPDATE runs SET input_json = JSON_QUOTE(?) WHERE id = ?", [LEAK, runId]);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.inject({ method: "GET", url: `/admin/api/runs/${runId}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("leak-");
    expect((res.json() as { input: unknown }).input).toEqual({});
    const lines = warned(spy, "input_json");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain(runId);
    expect(lines.join("\n")).not.toContain("leak-");
  });

  it("plugins.resources_json on reinstall -> treated as {} (only the new ids kept)", async () => {
    const key = k("reinst");
    const id = await repos.createPlugin({ key, version: "1.0.0", type: "mixed", name: key, manifest: {}, resources: { mcp: ["mcp_old"] } });
    await execute("UPDATE plugins SET resources_json = JSON_QUOTE(?) WHERE id = ?", [LEAK, id]);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await repos.createPlugin({ key, version: "1.0.0", type: "mixed", name: key, manifest: {}, resources: { skills: ["skl_new"] } })).toBe(id);
    expect((await query<{ r: unknown }>("SELECT resources_json AS r FROM plugins WHERE id = ?", [id]))[0]!.r).toEqual({ skills: ["skl_new"] });
    const lines = warned(spy, "resources_json");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).not.toContain("leak-");
  });
});
