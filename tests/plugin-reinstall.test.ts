import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (architect ruling; needs a *_test DB): reinstalling a plugin (same key + version, e.g. after an uninstall) reuses
// the original record and its `pkg_` id. Before, the upsert hit the unique key but the route returned (and audited)
// a freshly generated id that no row has, and resources_json was overwritten by this request's (usually empty)
// created list, so audit entries and the record's resource references broke.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const k = (tag: string): string => `it-preins-${tag}-${suffix}`;
let app: FastifyInstance;
let session: Session;
let headers: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await realSession({ name: "IT preins", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(session, sessionCookieValue(session));
});

afterAll(async () => {
  const like = `it-preins-%-${suffix}`;
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE `key` LIKE ?", [like]);
  await execute("DELETE v FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.`key` LIKE ?", [like]);
  await execute("DELETE FROM agents WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM skills WHERE `key` LIKE ?", [like]);
  await execute("DELETE FROM plugins WHERE `key` LIKE ?", [like]);
  await cleanupRealSessions();
  await app.close();
});

const pkg = (extraSkill = false) => ({
  key: k("pkg"),
  version: "1.0.0",
  resources: {
    agents: [{ key: k("agent"), spec: { model: { provider: "mock", model: "mock-1" } } }],
    skills: [{ key: k("skill"), content: "# s" }, ...(extraSkill ? [{ key: k("skill2"), content: "# s2" }] : [])],
  },
});
const install = (payload: unknown) => app.inject({ method: "POST", url: "/admin/api/plugins/install", headers, payload: payload as object });
const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Record<string, string[]>;

describe("P2 plugin reinstall keeps the pkg_ id", () => {
  it("install -> uninstall -> reinstall: same id, one row, references intact", async () => {
    const first = await install(pkg());
    expect(first.statusCode, first.body).toBe(200);
    const id = first.json().id as string;
    expect(id).toMatch(/^pkg_/);
    const original = parse((await repos.getPlugin(id))!.resources_json);
    expect(original.agents).toHaveLength(1);

    const un = await app.inject({ method: "POST", url: `/admin/api/plugins/${id}/uninstall`, headers });
    expect(un.statusCode).toBe(200);

    const again = await install(pkg(true));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(id);
    const rows = await query<{ id: string; status: string; resources_json: unknown }>("SELECT id, status, resources_json FROM plugins WHERE `key` = ?", [k("pkg")]);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0]!.status).toBe("active");
    // The original references are kept; resources created by the reinstall are added.
    const merged = parse(rows[0]!.resources_json);
    expect(merged.agents).toEqual(original.agents);
    expect(merged.skills).toEqual(expect.arrayContaining([...original.skills!, ...(again.json().created.skills as string[])]));
    expect(merged.skills).toHaveLength(2);

    const audits = await query<{ action: string; resource_id: string }>(
      "SELECT action, resource_id FROM audit_logs WHERE actor_id = ? AND resource_type = 'plugin' ORDER BY created_at, id", [session.principal.id]);
    expect(audits.map((a) => [a.action, a.resource_id])).toEqual([["plugin.install", id], ["plugin.uninstall", id], ["plugin.install", id]]);
    for (const a of audits) expect(await repos.getPlugin(a.resource_id)).toBeTruthy();
  });
});
