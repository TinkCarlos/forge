import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item 7 (needs a *_test DB): `spec` / `headers` sent as JSON text that does not parse (or parses to something other
// than an object) used to be replaced silently by a default ({} or the mock spec) and saved. Now: 400 CFG-8501 with
// details.field, nothing written (agent create no longer leaves an agent row behind).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const k = (tag: string): string => `it-jtx-${tag}-${suffix}`;
const BAD = ["{bad", "[1]", "\"x\""];
let app: FastifyInstance;
let session: Session;
let headers: Record<string, string> = {};
let agentId = "";
let mcpId = "";
let providerId = "";

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await realSession({ name: "IT jtx", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
  agentId = await repos.createAgent({ key: k("agent"), name: "IT jtx", ownerOrgUnitId: ROOT, createdBy: session.principal.id });
  mcpId = await repos.createMcpServer({ key: k("mcp"), name: "IT jtx", url: "https://mcp.example.com/m", headers: { "X-A": "1" }, transport: "http", createdBy: session.principal.id });
  providerId = await repos.createProvider({ key: k("prov"), name: "IT jtx", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKeyEncrypted: null, headers: { "X-A": "1" }, timeoutMs: 120000, createdBy: session.principal.id });
});

afterAll(async () => {
  const like = `it-jtx-%-${suffix}`;
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE `key` LIKE ?", [like]);
  await execute("DELETE v FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.`key` LIKE ?", [like]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM mcp_servers WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM llm_providers WHERE `key` LIKE ?", [like]);
  await execute("DELETE t FROM tools t JOIN tool_sources s ON s.id = t.source_id WHERE s.`key` LIKE ?", [like]);
  await execute("DELETE FROM tool_sources WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM plugins WHERE `key` LIKE ?", [like]);
  await cleanupRealSessions();
  await app.close();
});

const send = async (method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers: await configurationHeaders(url, headers), payload });
const count = async (table: string, key: string) => Number((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE \`key\` = ?`, [key]))[0]!.n);
const expect400 = (res: { statusCode: number; body: string; json: () => unknown }, field: string) => {
  expect(res.statusCode, res.body).toBe(400);
  const error = (res.json() as { error: { code: string; details?: { field?: string } } }).error;
  expect(error.code).toBe("CFG-8501");
  expect(error.details?.field).toBe(field);
};
const OPENAPI = { openapi: "3.0.0", info: { title: "t", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: {} };

describe("item 7: spec / headers JSON text that is not a JSON object -> 400", () => {
  it.each(BAD)("POST /agents spec=%j -> 400, no agent row", async (bad) => {
    const key = k(`a${BAD.indexOf(bad)}`);
    expect400(await send("POST", "/admin/api/agents", { key, spec: bad }), "spec");
    expect(await count("agents", key)).toBe(0);
  });

  it.each(BAD)("POST /agents/{id}/versions spec=%j -> 400, no version", async (bad) => {
    expect400(await send("POST", `/admin/api/agents/${agentId}/versions`, { version: "9.9.9", spec: bad }), "spec");
    expect(await query("SELECT id FROM agent_versions WHERE agent_id = ?", [agentId])).toHaveLength(0);
  });

  it.each(BAD)("POST /mcp and PATCH /mcp/{id} headers=%j -> 400, nothing written", async (bad) => {
    const key = k(`m${BAD.indexOf(bad)}`);
    expect400(await send("POST", "/admin/api/mcp", { key, url: "https://mcp.example.com/x", headers: bad }), "headers");
    expect(await count("mcp_servers", key)).toBe(0);
    expect400(await send("PATCH", `/admin/api/mcp/${mcpId}`, { headers: bad }), "headers");
    const row = (await query<{ headers_json: unknown; header_secret_refs_json: Record<string,string> }>("SELECT headers_json, header_secret_refs_json FROM mcp_servers WHERE id = ?", [mcpId]))[0]!;
    expect(row.headers_json).toEqual({});
    expect(Object.keys(row.header_secret_refs_json)).toEqual(["x-a"]);
    expect(await repos.resolveCredentialValues("mcp_server", mcpId, {"header:x-a":row.header_secret_refs_json["x-a"]!})).toEqual({"header:x-a":"1"});
  });

  it.each(BAD)("POST /providers and PATCH /providers/{id} headers=%j -> 400, nothing written", async (bad) => {
    const key = k(`p${BAD.indexOf(bad)}`);
    expect400(await send("POST", "/admin/api/providers", { key, baseUrl: "https://llm.example.com/v1", headers: bad }), "headers");
    expect(await count("llm_providers", key)).toBe(0);
    expect400(await send("PATCH", `/admin/api/providers/${providerId}`, { headers: bad }), "headers");
    const row = (await query<{ headers_json: unknown; header_secret_refs_json: Record<string,string> }>("SELECT headers_json, header_secret_refs_json FROM llm_providers WHERE id = ?", [providerId]))[0]!;
    expect(row.headers_json).toEqual({});
    expect(Object.keys(row.header_secret_refs_json)).toEqual(["x-a"]);
    expect(await repos.resolveCredentialValues("llm_provider", providerId, {"header:x-a":row.header_secret_refs_json["x-a"]!})).toEqual({"header:x-a":"1"});
  });

  it.each(BAD)("POST /tool-sources/import headers=%j -> 400, no source", async (bad) => {
    const key = k(`t${BAD.indexOf(bad)}`);
    expect400(await send("POST", "/admin/api/tool-sources/import", { key, spec: OPENAPI, headers: bad }), "headers");
    expect(await count("tool_sources", key)).toBe(0);
  });

  it.each(BAD)("POST /plugins/install agent spec=%j -> 400, nothing created", async (bad) => {
    const key = k(`g${BAD.indexOf(bad)}`);
    expect400(await send("POST", "/admin/api/plugins/install", { key, resources: { agents: [{ key: k(`ga${BAD.indexOf(bad)}`), spec: bad }] } }), "spec");
    expect(await count("plugins", key)).toBe(0);
    expect(await count("agents", k(`ga${BAD.indexOf(bad)}`))).toBe(0);
  });

  it("valid JSON object text is still accepted and parsed", async () => {
    const key = k("ok");
    const res = await send("POST", "/admin/api/mcp", { key, url: "https://mcp.example.com/ok", headers: "{\"X-Ok\":\"1\"}" });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await query<{ id:string; headers_json: unknown; header_secret_refs_json:Record<string,string> }>("SELECT id, headers_json, header_secret_refs_json FROM mcp_servers WHERE `key` = ?", [key]))[0]!;
    expect(row.headers_json).toEqual({});
    expect(Object.keys(row.header_secret_refs_json)).toEqual(["x-ok"]);
    expect(await repos.resolveCredentialValues("mcp_server", row.id, {"header:x-ok":row.header_secret_refs_json["x-ok"]!})).toEqual({"header:x-ok":"1"});
  });
});
