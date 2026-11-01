import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// S-29 (#10 / I-PLG-01): POST /admin/api/plugins/install used to create agents / skills / providers one by one and only
// then read the top-level key, so a bad package left orphan resources and no audit. Now (1) every field of the whole
// package is read and checked before anything is created (400, nothing written, nothing audited), and (2) a failure
// after creation started (DB conflict, createPlugin error) removes everything this request created and writes one
// `plugin.install.failed` audit entry listing what was rolled back. Needs a *_test DB.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const k = (tag: string): string => `it-s29-${tag}-${suffix}`;
let app: FastifyInstance;
let session: Session;
let headers: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await realSession({ name: "IT s29", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  const like = `it-s29-%-${suffix}`;
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE `key` LIKE ?", [like]);
  await execute("DELETE v FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.`key` LIKE ?", [like]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM skills WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM mcp_servers WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM llm_providers WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM plugins WHERE `key` LIKE ?", [like]);
  await cleanupRealSessions();
  await app.close();
});

const install = async (payload: unknown) => app.inject({ method: "POST", url: "/admin/api/plugins/install", headers: await configurationHeaders("/admin/api/plugins/install", headers), payload: payload as object });

async function residue(tag: string): Promise<Record<string, number>> {
  const like = `it-s29-${tag}%-${suffix}`;
  const count = async (table: string) => Number((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE \`key\` LIKE ?`, [like]))[0]!.n);
  return { agents: await count("agents"), skills: await count("skills"), mcp: await count("mcp_servers"), providers: await count("llm_providers"), plugins: await count("plugins") };
}
const NONE = { agents: 0, skills: 0, mcp: 0, providers: 0, plugins: 0 };

async function audits(action: string): Promise<Array<{ details: unknown }>> {
  const rows = await query<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE actor_id = ? AND action = ? AND outcome = ? ORDER BY created_at", [session.principal.id, action, action.endsWith(".failed") ? "failure" : "success"]);
  return rows.map((r) => ({ details: typeof r.details_json === "string" ? JSON.parse(r.details_json) : r.details_json }));
}

const goodResources = (tag: string) => ({
  agents: [{ key: k(`${tag}-agent`), spec: { model: { provider: "mock", model: "mock-1" } } }],
  skills: [{ key: k(`${tag}-skill`), content: "# s" }],
  providers: [{ key: k(`${tag}-prov`), baseUrl: "https://llm.example.com/v1", models: [{ key: "m-1" }] }],
});

describe("S-29: validate the whole package before creating anything", () => {
  it.each([
    ["top-level key missing", "nokey", (t: string) => ({ resources: goodResources(t) }), "key"],
    ["second agent has no key", "agent2", (t: string) => ({ key: k(t), resources: { ...goodResources(t), agents: [...goodResources(t).agents, { name: "x" }] } }), "key"],
    ["provider model has no key", "model", (t: string) => ({ key: k(t), resources: { ...goodResources(t), providers: [{ key: k(`${t}-prov`), baseUrl: "https://llm.example.com/v1", models: [{ displayName: "x" }] }] } }), "key"],
    ["skill (after a valid agent) has no key", "skill", (t: string) => ({ key: k(t), resources: { ...goodResources(t), skills: [{ content: "# s" }] } }), "key"],
    ["mcp entry (after valid agents) has no url (I-PLG-01)", "mcpurl", (t: string) => ({ key: k(t), resources: { ...goodResources(t), mcp: [{ key: k(`${t}-mcp`) }] } }), "url"],
  ])("%s -> 400, nothing created, nothing audited", async (_label, tag, build, field) => {
    const before = (await audits("plugin.install.failed")).length;
    const res = await install(build(tag));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CFG-8501");
    expect(JSON.stringify(res.json())).toContain(field);
    expect(await residue(tag)).toEqual(NONE);
    expect(await audits("plugin.install.failed")).toHaveLength(before);
  });
});

describe("S-29: a failure after creation started is compensated and audited", () => {
  it("duplicate model key inside the package (DB conflict) -> 409, created agent/skill/provider removed, plugin.install.failed audited", async () => {
    const tag = "dup";
    const resources = { ...goodResources(tag), providers: [{ key: k(`${tag}-prov`), baseUrl: "https://llm.example.com/v1", models: [{ key: "m-1" }, { key: "m-1" }] }] };
    const res = await install({ key: k(tag), resources });
    expect(res.statusCode).toBe(409);
    expect(await residue(tag)).toEqual(NONE);
    const failed = (await audits("plugin.install.failed")).filter((a) => JSON.stringify(a.details).includes(k(tag)));
    expect(failed).toHaveLength(1);
    const details = failed[0]!.details as { key: string; rolledBack: Record<string, string[]>; compensated: boolean; error: string };
    expect(details.key).toBe(k(tag));
    expect(details.compensated).toBe(true);
    expect([details.rolledBack.agents!.length, details.rolledBack.skills!.length, details.rolledBack.providers!.length]).toEqual([1, 1, 1]);
    expect(details.error).toBe("CFG-8503");
  });

  it("createPlugin itself fails -> every created resource removed, one failed audit, no plugin.install audit", async () => {
    const tag = "plg";
    vi.spyOn(repos, "createPlugin").mockRejectedValueOnce(new Error("boom"));
    const before = (await audits("plugin.install")).length;
    const res = await install({ key: k(tag), resources: goodResources(tag) });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toContain("boom");
    expect(await residue(tag)).toEqual(NONE);
    expect((await audits("plugin.install.failed")).filter((a) => JSON.stringify(a.details).includes(k(tag)))).toHaveLength(1);
    expect(await audits("plugin.install")).toHaveLength(before);
  });

  it("a valid package still installs and is audited once as plugin.install", async () => {
    const tag = "ok";
    const res = await install({ key: k(tag), resources: goodResources(tag) });
    expect(res.statusCode).toBe(200);
    expect(await residue(tag)).toEqual({ agents: 1, skills: 1, mcp: 0, providers: 1, plugins: 1 });
  });
});
