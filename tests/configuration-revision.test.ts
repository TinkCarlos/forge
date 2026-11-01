import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { MAX_REVISION, requireRevision, revisionTag } from "@forge/core";
import { CONFIGURATION_RESULT, CONFIGURATION_ROUTES, CONFIGURATION_VERSION_RESULT, CONFIGURATION_PUBLISH_RESULT, CONFIGURATION_MCP_RESULT } from "@forge/contracts";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { auditRepo } from "../packages/store/src/repositories/audit.js";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

const discovery = vi.hoisted(() => vi.fn(async () => [] as Array<{ name: string }>));
vi.mock("@forge/capabilities", async (original) => ({ ...await original<typeof import("@forge/capabilities")>(), discoverMcpTools: discovery }));
const ROOT = "01J00000000000000000000000";
const tag = randomUUID();
const extraMcpIds: string[] = [];
const extraPluginIds: string[] = [];
const ids = { agents: "", version: "", skills: "", mcp_servers: "", llm_providers: "", llm_models: "", api_apps: "", users: "", service_accounts: "", schedules: "", plugins: "", oidc_role_mappings: "" };
let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Record<string, string>;
let forbidden: Record<string, string>;
const revision = async (kind: keyof typeof ids) => Number((await one<{ revision: number }>(`SELECT revision FROM ${kind} WHERE id = ?`, [ids[kind]]))!.revision);
const call = (method: "POST" | "PATCH", path: string, body: Record<string, unknown> = {}, token?: string, auth = headers) => app.inject({ method, url: `/admin/api${path}`, headers: { ...auth, ...(token === undefined ? {} : { "if-match": token }) }, payload: body });
const auditCount = async (id = ids.agents) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM audit_logs WHERE outcome = 'success' AND resource_id = ?", [id]))!.n);
const validResult = new Ajv().compile(CONFIGURATION_RESULT);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const role of ["platform_admin", "user"] as const) {
    const s = await realSession({ role, dataScope: role === "platform_admin" ? "all" : "self", orgUnitId: ROOT });
    const h = sessionHeaders(s, sessionCookieValue(s));
    if (role === "platform_admin") headers = h; else forbidden = h;
  }
  ids.agents = await repos.createAgent({ key: `it-rev-${tag}`, name: "revision", ownerOrgUnitId: ROOT });
  ids.version = await repos.createAgentVersion({ agentId: ids.agents, version: "1.0.0", instructions: "test", spec: {}, status: "published" }, { expectedRevision: "system" });
  ids.skills = await repos.createSkill({ key: `it-rev-${tag}`, name: "revision", content: "# Test" });
  ids.mcp_servers = await repos.createMcpServer({ key: `it-rev-${tag}`, name: "revision", url: "http://127.0.0.1:8090/mcp" });
  ids.llm_providers = await repos.createProvider({ key: `it-rev-${tag}`, name: "revision", protocol: "mock", baseUrl: "http://127.0.0.1:8090" });
  ids.llm_models = await repos.createModel({ providerId: ids.llm_providers, key: "test", displayName: "test", capabilities: ["text"] });
  ids.api_apps = await repos.createApiApp({ key: `it-rev-${tag}`, name: "revision", ownerOrgUnitId: ROOT, scopes: [] });
  ids.users = await repos.createUser({ email: `it-rev-${tag}@forge.local`, username: `rev-${tag}`, displayName: "revision", orgUnitId: ROOT });
  ids.service_accounts = await repos.createServiceAccount({ key: `it-rev-${tag}`, name: "revision", orgUnitId: ROOT });
  ids.schedules = await repos.createSchedule({ key: `it-rev-${tag}`, name: "revision", agentId: ids.agents, orgUnitId: ROOT, subjectType: "service", subjectId: ids.service_accounts, serviceAccountId: ids.service_accounts, cron: "0 9 * * *", timezone: "Asia/Shanghai", input: {} });
  ids.plugins = await repos.createPlugin({ key: `it-rev-${tag}`, version: "1", type: "declarative", name: "revision", manifest: {}, resources: {} });
  await repos.upsertRoleMapping(`it-rev-${tag}`, "test", "user", { expectedRevision: "system" });
  ids.oidc_role_mappings = String((await repos.listRoleMappings()).find(r => r.agent_role_code === `it-rev-${tag}`)!.id);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await execute("DELETE FROM audit_logs WHERE resource_id IN (" + Object.values(ids).map(() => "?").join(",") + ")", Object.values(ids));
  await execute("DELETE FROM schedules WHERE id = ?", [ids.schedules]);
  await execute("UPDATE agents SET latest_version_id = NULL, published_version_id = NULL WHERE id = ?", [ids.agents]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [ids.agents]);
  for (const table of ["agents", "skills", "mcp_servers", "llm_providers", "api_apps", "users", "service_accounts", "plugins", "oidc_role_mappings"]) await execute(`DELETE FROM ${table} WHERE id = ?`, [ids[table as keyof typeof ids]]);
  await execute("DELETE FROM oidc_role_mappings WHERE agent_role_code LIKE ?", [`it-rev-${tag}%`]);
  for (const id of extraPluginIds) await execute("DELETE FROM plugins WHERE id = ?", [id]);
  for (const id of extraMcpIds) await execute("DELETE FROM mcp_servers WHERE id = ?", [id]);
  await cleanupRealSessions();
  await app?.close();
});

describe("REV: strict revision tags", () => {
  it.each([0, -1, 1.5, MAX_REVISION + 1, NaN])("rejects invalid revision %s", n => expect(() => revisionTag(n)).toThrow());
  it.each(['1', '"0"', '"01"', 'W/"1"', '*', '"1","2"', '"4294967296"', ['"1"']])("rejects malformed If-Match %s", h => expect(() => requireRevision(h)).toThrow());
  it("accepts exact bounds and reports missing precondition", () => {
    expect(requireRevision('"1"')).toBe(1);
    expect(requireRevision(`"${MAX_REVISION}"`)).toBe(MAX_REVISION);
    expect(() => requireRevision(undefined)).toThrow(expect.objectContaining({ code: "CFG-8505", httpStatus: 428 }));
  });
});

describe("REV: real MySQL configuration writes", () => {
  it("covers every existing configuration write route with required preconditions", async () => {
    const paths: Record<string, [string, Record<string, unknown>]> = {
      "/agents/{id}": [ids.agents, { name: "unchanged" }], "/agents/{id}/versions": [ids.agents, { version: "2.0.0", instructions: "test", spec: {} }], "/agents/{id}/publish": [ids.agents, { versionId: ids.version }],
      "/skills/{id}": [ids.skills, { name: "unchanged" }], "/skills/{id}/versions": [ids.skills, { version: "2.0.0", content: "# test" }],
      "/mcp/{id}": [ids.mcp_servers, { name: "unchanged" }], "/mcp/{id}/refresh": [ids.mcp_servers, {}], "/providers/{id}": [ids.llm_providers, { name: "unchanged" }], "/models/{id}": [ids.llm_models, { displayName: "unchanged" }],
      "/apps/{id}": [ids.api_apps, { name: "unchanged" }], "/users/{id}": [ids.users, { role: "user", dataScope: "self" }], "/service-accounts/{id}": [ids.service_accounts, { name: "unchanged" }],
      "/schedules/{id}": [ids.schedules, { name: "unchanged" }], "/schedules/{id}/enable": [ids.schedules, {}], "/schedules/{id}/disable": [ids.schedules, {}], "/plugins/{id}/uninstall": [ids.plugins, {}],
      "/role-mappings": ["", { agentRoleCode: `it-rev-${tag}`, localRole: "user" }],
    };
    for (const [method, path] of CONFIGURATION_ROUTES) {
      const [id, body] = paths[path]!;
      const res = await call(method as "PATCH" | "POST", path.replace("{id}", id), body);
      expect([path, res.statusCode, res.json().error?.code]).toEqual([path, 428, "CFG-8505"]);
    }
    expect(discovery).not.toHaveBeenCalled();
  });

  it("serializes two editors, commits one audit, preserves winner, returns revision and ETag", async () => {
    const current = await revision("agents"), before = await auditCount();
    const responses = await Promise.all(["first", "second"].map(name => call("PATCH", `/agents/${ids.agents}`, { name }, revisionTag(current))));
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const success = responses.find(r => r.statusCode === 200)!;
    expect(validResult(success.json()), JSON.stringify(validResult.errors)).toBe(true);
    expect(success.headers.etag).toBe(revisionTag(current + 1));
    expect(await revision("agents")).toBe(current + 1);
    expect(await auditCount()).toBe(before + 1);
    const detail = await app.inject({ method: "GET", url: `/admin/api/agents/${ids.agents}`, headers });
    expect(detail.headers.etag).toBe(success.headers.etag);
    expect(detail.json().revision).toBe(current + 1);
    expect(detail.json().publishedVersion).toBe("1.0.0");
  });

  it("checks authorization, visibility and body before missing precondition", async () => {
    expect((await call("PATCH", `/agents/${ids.agents}`, { name: "denied" }, undefined, {})).statusCode).toBe(401);
    expect((await call("PATCH", `/agents/${ids.agents}`, { name: "denied" }, undefined, forbidden)).statusCode).toBe(403);
    expect((await call("PATCH", "/agents/unknown", { name: "denied" })).statusCode).toBe(404);
    expect((await call("PATCH", `/agents/${ids.agents}`, { name: 42 })).statusCode).toBe(400);
    expect((await call("PATCH", `/agents/${ids.agents}`, { name: "test" }, '*')).statusCode).toBe(400);
  });

  it("validates version bodies before absent or malformed If-Match", async () => {
    for (const token of [undefined, "*"]) for (const [path, body] of [
      [`/agents/${ids.agents}/versions`, {}], [`/agents/${ids.agents}/versions`, { version: "invalid-json", spec: "{bad" }], [`/skills/${ids.skills}/versions`, {}],
    ] as const) {
      const response = await call("POST", path, body, token);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("CFG-8501");
    }
  });

  it("writes every ordinary configuration resource with its captured revision", async () => {
    for (const [kind, path, body] of [
      ["agents", "agents", { name: "edited" }], ["skills", "skills", { name: "edited" }], ["mcp_servers", "mcp", { name: "edited" }], ["llm_providers", "providers", { name: "edited" }], ["llm_models", "models", { displayName: "edited" }], ["api_apps", "apps", { name: "edited" }], ["users", "users", { role: "user", dataScope: "self" }], ["service_accounts", "service-accounts", { name: "edited" }], ["schedules", "schedules", { name: "edited" }],
    ] as const) {
      const before = await revision(kind);
      const response = await call("PATCH", `/${path}/${ids[kind]}`, body, revisionTag(before));
      expect(response.statusCode, response.body).toBe(200);
      expect(validResult(response.json())).toBe(true);
      expect(response.json().revision).toBe(before + 1);
      expect(await revision(kind)).toBe(before + 1);
    }
  });

  it("returns the full version/publication result contract", async () => {
    const ajv = new Ajv();
    for (const [kind, path, body] of [["agents", "agents", { version: "contract", instructions: "test", spec: {}, publish: false }], ["skills", "skills", { version: "contract", content: "# test", publish: false }]] as const) {
      const response = await call("POST", `/${path}/${ids[kind]}/versions`, body, revisionTag(await revision(kind)));
      expect(response.statusCode, response.body).toBe(200);
      expect(ajv.validate(CONFIGURATION_VERSION_RESULT, response.json()), JSON.stringify(ajv.errors)).toBe(true);
    }
    const published = await call("POST", `/agents/${ids.agents}/publish`, { versionId: ids.version }, revisionTag(await revision("agents")));
    expect(ajv.validate(CONFIGURATION_PUBLISH_RESULT, published.json()), JSON.stringify(ajv.errors)).toBe(true);
  });

  it("creates distinct role mappings concurrently without index-gap deadlocks and fences existing codes", async () => {
    const results = await Promise.all(["-a", "-b", "-c"].map(suffix => call("POST", "/role-mappings", { agentRoleCode: `it-rev-${tag}${suffix}`, localRole: "user" })));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const body = { agentRoleCode: `it-rev-${tag}`, agentRoleName: "updated", localRole: "operator" };
    const before = await revision("oidc_role_mappings");
    const changed = await call("POST", "/role-mappings", body, revisionTag(before));
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await revision("oidc_role_mappings")).toBe(before + 1);
    expect((await call("POST", "/role-mappings", body, revisionTag(before))).statusCode).toBe(409);
  });

  it("rolls back configuration, new child version and audit together if audit fails", async () => {
    const current = await revision("agents"), before = await auditCount();
    const failure = vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("injected audit failure"));
    const res = await call("POST", `/agents/${ids.agents}/versions`, { version: "rollback", instructions: "test", spec: {} }, revisionTag(current));
    failure.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(await revision("agents")).toBe(current);
    expect((await repos.listAgentVersions(ids.agents)).some(v => v.version === "rollback")).toBe(false);
    expect(await auditCount()).toBe(before);
  });

  it("publishes idempotently only with the current parent revision", async () => {
    const current = await revision("agents"), before = await auditCount(ids.version);
    const result = await call("POST", `/agents/${ids.agents}/publish`, { versionId: ids.version }, revisionTag(current));
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().changed).toBe(false);
    expect(await revision("agents")).toBe(current);
    expect(await auditCount(ids.version)).toBe(before);
    expect((await call("POST", `/agents/${ids.agents}/publish`, { versionId: ids.version }, revisionTag(current - 1))).statusCode).toBe(409);
  });

  it("rejects MCP catalog submission when source is edited during discovery", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    discovery.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return [{ name: "stale" }]; });
    const current = await revision("mcp_servers");
    const refreshing = call("POST", `/mcp/${ids.mcp_servers}/refresh`, {}, revisionTag(current)).then(r => r);
    await entered;
    const edited = await call("PATCH", `/mcp/${ids.mcp_servers}`, { name: "new-source" }, revisionTag(current));
    release();
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await refreshing).statusCode).toBe(409);
    expect(await repos.listMcpTools(ids.mcp_servers)).toEqual([]);
    expect((await repos.getMcpServer(ids.mcp_servers))!.name).toBe("new-source");
  });

  it.each([false, true])("preserves a concurrently edited MCP while creating via plugin=%s", async (plugin) => {
    const key = `it-rev-create-${tag}-${plugin}`;
    discovery.mockImplementationOnce(async () => {
      const row = (await repos.getMcpServerByKey(key))!;
      extraMcpIds.push(String(row.id));
      const edited = await call("PATCH", `/mcp/${row.id}`, { name: "newer edit" }, revisionTag(Number(row.revision)));
      expect(edited.statusCode, edited.body).toBe(200);
      return [{ name: "stale-catalog" }];
    });
    const source = { key, name: "created", url: "https://mcp.example.com/mcp" };
    const response = plugin
      ? await call("POST", "/plugins/install", { key, name: key, version: "1.0.0", type: "declarative", resources: { mcp: [source] } })
      : await call("POST", "/mcp", source);
    expect(response.statusCode, response.body).toBe(200);
    if (plugin) extraPluginIds.push(response.json().id);
    else expect(response.json().warning).toBeTruthy();
    const row = (await repos.getMcpServerByKey(key))!;
    expect(row.name).toBe("newer edit");
    expect(row.revision).toBe(2);
    expect(row.last_error).toBeNull();
    expect(await repos.listMcpTools(String(row.id))).toEqual([]);
  });

  it("returns the full MCP catalog response contract", async () => {
    const result = await call("POST", `/mcp/${ids.mcp_servers}/refresh`, {}, revisionTag(await revision("mcp_servers")));
    expect(result.statusCode, result.body).toBe(200);
    expect(new Ajv().validate(CONFIGURATION_MCP_RESULT, result.json())).toBe(true);
  });

  it("clock updates preserve revision; automatic pause invalidates forms and stale ticks cannot overwrite repairs", async () => {
    const current = await revision("schedules");
    await repos.advanceScheduleClock(ids.schedules, new Date(), current);
    expect(await revision("schedules")).toBe(current);
    await repos.recordScheduleFailure(ids.schedules, "SCD-4801", current);
    expect(await revision("schedules")).toBe(current + 1);
    const edited = await call("PATCH", `/schedules/${ids.schedules}`, { name: "repaired" }, revisionTag(current + 1));
    expect(edited.statusCode, edited.body).toBe(200);
    await repos.recordScheduleFailure(ids.schedules, "SCD-4801", current);
    expect(await revision("schedules")).toBe(current + 2);
  });

  it("empty patches keep revision; UINT maximum fails closed", async () => {
    const current = await revision("api_apps");
    const empty = await call("PATCH", `/apps/${ids.api_apps}`, {}, revisionTag(current));
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().revision).toBe(current);
    await execute("UPDATE api_apps SET revision = ? WHERE id = ?", [MAX_REVISION, ids.api_apps]);
    expect((await call("PATCH", `/apps/${ids.api_apps}`, { name: "overflow" }, revisionTag(MAX_REVISION))).statusCode).toBe(409);
    expect(await revision("api_apps")).toBe(MAX_REVISION);
  });
});
