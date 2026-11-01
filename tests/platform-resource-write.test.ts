import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Principal } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Acceptance P0-03 / U-15 (S-22), needs a *_test DB. MCP servers, Skills, tool sources, plugins and LLM
// Providers/Models have no department column (schema.sql), i.e. they are platform-wide (org = null). Writing them
// therefore needs dataScope=all: assertOrgWritable(principal, null). org_admin / builder with dataScope org get
// 403 POL-2001 even though their role has mcp/skill/tool/model.manage and plugin.install; nothing is written and
// nothing audited. Plugin uninstall stays platform-only (plugin.uninstall, held by platform_admin only).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (t: string): string => `${t}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const D = id26("IPRD");
const k = (name: string) => `it-pr-${name}-${suffix}`;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const headers: Record<string, Record<string, string>> = {};
const actors: string[] = [];

async function login(name: string, principal: Pick<Principal, "role" | "orgUnitId" | "dataScope">) {
  const session = await realSession({ name: `IT pr ${name}`, ...principal });
  actors.push(session.principal.id);
  headers[name] = sessionHeaders(session, sessionCookieValue(session));
}
const n = async (sql: string, params: unknown[]) => Number((await query<{ n: number }>(sql, params))[0]!.n);
async function snapshot() {
  const like = `it-pr-%-${suffix}`;
  return {
    mcp: await query("SELECT `key`, name, url, status, updated_at FROM mcp_servers WHERE `key` LIKE ? ORDER BY `key`", [like]),
    mcpTools: await n("SELECT COUNT(*) AS n FROM mcp_tools WHERE server_id = ?", [ids.mcp]),
    skills: await query("SELECT `key`, name, status, updated_at FROM skills WHERE `key` LIKE ? ORDER BY `key`", [like]),
    skillVersions: await n("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = ?", [ids.skill]),
    toolSources: await n("SELECT COUNT(*) AS n FROM tool_sources WHERE `key` LIKE ?", [like]),
    providers: await query("SELECT `key`, name, base_url, status, updated_at FROM llm_providers WHERE `key` LIKE ? ORDER BY `key`", [like]),
    models: await query("SELECT `key`, display_name, status, updated_at FROM llm_models WHERE provider_id = ? ORDER BY `key`", [ids.provider]),
    plugins: await n("SELECT COUNT(*) AS n FROM plugins WHERE `key` LIKE ?", [like]),
    audit: await n(`SELECT COUNT(*) AS n FROM audit_logs WHERE outcome = 'success' AND actor_id IN (${actors.map(() => "?").join(",")})`, actors),
  };
}

const writes: Record<string, (h: Record<string, string>) => Promise<LightMyRequestResponse>> = {
  "POST /mcp": (h) => app.inject({ method: "POST", url: "/admin/api/mcp", headers: h, payload: { key: k("mcp-new"), name: "x", url: "https://mcp.example.com/mcp" } }),
  "PATCH /mcp/:id": async (h) => app.inject({ method: "PATCH", url: `/admin/api/mcp/${ids.mcp}`, headers: await configurationHeaders(`/admin/api/mcp/${ids.mcp}`, h), payload: { name: "renamed" } }),
  "POST /mcp/:id/refresh": async (h) => app.inject({ method: "POST", url: `/admin/api/mcp/${ids.mcp}/refresh`, headers: await configurationHeaders(`/admin/api/mcp/${ids.mcp}/refresh`, h) }),
  "POST /skills": (h) => app.inject({ method: "POST", url: "/admin/api/skills", headers: h, payload: { key: k("skill-new"), name: "x", content: "x" } }),
  "PATCH /skills/:id": async (h) => app.inject({ method: "PATCH", url: `/admin/api/skills/${ids.skill}`, headers: await configurationHeaders(`/admin/api/skills/${ids.skill}`, h), payload: { name: "renamed" } }),
  "POST /skills/:id/versions": async (h) => app.inject({ method: "POST", url: `/admin/api/skills/${ids.skill}/versions`, headers: await configurationHeaders(`/admin/api/skills/${ids.skill}/versions`, h), payload: { version: "9.9.9", content: "y" } }),
  "POST /tool-sources/import": (h) =>
    app.inject({ method: "POST", url: "/admin/api/tool-sources/import", headers: h, payload: { key: k("tls-new"), baseUrl: "https://api.example.com", spec: { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} } } }),
  "POST /plugins/install": async (h) =>
    app.inject({ method: "POST", url: "/admin/api/plugins/install", headers: await configurationHeaders("/admin/api/plugins/install", h), payload: { key: k("plugin-new"), resources: { skills: [{ key: k("skill-plugin"), content: "x" }] } } }),
  "POST /providers": (h) => app.inject({ method: "POST", url: "/admin/api/providers", headers: h, payload: { key: k("prv-new"), name: "x", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1" } }),
  "POST /providers/:id/models": async (h) => app.inject({ method: "POST", url: `/admin/api/providers/${ids.provider}/models`, headers: await configurationHeaders(`/admin/api/providers/${ids.provider}/models`, h), payload: { key: "m-new", displayName: "x" } }),
  "PATCH /providers/:id": async (h) => app.inject({ method: "PATCH", url: `/admin/api/providers/${ids.provider}`, headers: await configurationHeaders(`/admin/api/providers/${ids.provider}`, h), payload: { name: "renamed" } }),
  "PATCH /models/:id": async (h) => app.inject({ method: "PATCH", url: `/admin/api/models/${ids.model}`, headers: await configurationHeaders(`/admin/api/models/${ids.model}`, h), payload: { displayName: "renamed" } }),
  "POST /providers/:id/test": async (h) => app.inject({ method: "POST", url: `/admin/api/providers/${ids.provider}/test`, headers: await configurationHeaders(`/admin/api/providers/${ids.provider}/test`, h) }),
};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [D, ROOT, `it-pr-d-${suffix}`, "IT pr D", `/it-pr-d-${suffix}/`]);
  ids.mcp = await repos.createMcpServer({ key: k("mcp"), name: "IT pr mcp", url: "https://mcp.example.com/mcp", createdBy: ADMIN_ID });
  ids.skill = await repos.createSkill({ key: k("skill"), name: "IT pr skill", content: "x", publish: true, createdBy: ADMIN_ID });
  ids.provider = await repos.createProvider({ key: k("prv"), name: "IT pr provider", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", createdBy: ADMIN_ID });
  ids.model = await repos.createModel({ providerId: ids.provider, key: "m-1", displayName: "IT pr model" });
  await login("oaOrg", { role: "org_admin", orgUnitId: D, dataScope: "org" });
  await login("builderOrg", { role: "builder", orgUnitId: D, dataScope: "org" });
  await login("oaAll", { role: "org_admin", orgUnitId: D, dataScope: "all" });
  await login("pa", { role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
});

afterAll(async () => {
  const like = `it-pr-%-${suffix}`;
  if (actors.length) await execute(`DELETE FROM audit_logs WHERE actor_id IN (${actors.map(() => "?").join(",")})`, actors);
  await execute("DELETE FROM plugins WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM tools WHERE source_id IN (SELECT id FROM tool_sources WHERE `key` LIKE ?)", [like]);
  await execute("DELETE FROM tool_sources WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM mcp_tools WHERE server_id IN (SELECT id FROM mcp_servers WHERE `key` LIKE ?)", [like]);
  await execute("DELETE FROM mcp_servers WHERE `key` LIKE ?", [like]);
  await execute("UPDATE skills SET published_version_id = NULL, latest_version_id = NULL WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE `key` LIKE ?)", [like]);
  await execute("DELETE FROM skills WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM llm_models WHERE provider_id IN (SELECT id FROM llm_providers WHERE `key` LIKE ?)", [like]);
  await execute("DELETE FROM llm_providers WHERE `key` LIKE ?", [like]);
  await cleanupRealSessions();
  await execute("DELETE FROM org_units WHERE id = ?", [D]);
  await app?.close();
});

describe("P0-03 platform-wide resources need dataScope=all", () => {
  for (const who of ["oaOrg", "builderOrg"]) {
    for (const [name, write] of Object.entries(writes)) {
      it(`${who} ${name} -> 403 POL-2001, nothing written, nothing audited`, async () => {
        const before = await snapshot();
        const res = await write(headers[who]!);
        expect(res.statusCode, res.body).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe("POL-2001");
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it("org_admin with dataScope=all may still write (POST /skills, PATCH /providers/:id -> 200)", async () => {
    expect((await writes["POST /skills"]!(headers.oaAll!)).statusCode).toBe(200);
    expect((await writes["PATCH /providers/:id"]!(headers.oaAll!)).statusCode).toBe(200);
  });

  it("platform_admin may write (PATCH /mcp/:id, PATCH /models/:id -> 200)", async () => {
    expect((await writes["PATCH /mcp/:id"]!(headers.pa!)).statusCode).toBe(200);
    expect((await writes["PATCH /models/:id"]!(headers.pa!)).statusCode).toBe(200);
  });

  it("plugin uninstall stays platform_admin-only: org_admin (org or all) and builder -> 403; platform_admin passes the check (404 for an unknown id)", async () => {
    const url = `/admin/api/plugins/${id26("PLG")}/uninstall`;
    for (const who of ["oaOrg", "oaAll", "builderOrg"]) {
      const res = await app.inject({ method: "POST", url, headers: headers[who]! });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
    }
    expect((await app.inject({ method: "POST", url, headers: headers.pa! })).statusCode).toBe(404);
  });
});
