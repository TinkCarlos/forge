import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P3 (architect, 4:25): POST /admin/api/role-mappings writes a platform-wide table (oidc_role_mappings, no department
// column), so it follows P0-03: assertOrgWritable(principal, null) after the sso.manage check. Only platform_admin
// holds sso.manage ("*"); a platform_admin whose dataScope is not "all" gets 403 POL-2001, nothing written or audited.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const code = (n: string) => `it-rm-${n}-${suffix}`;
let app: FastifyInstance;
const headers: Record<string, Record<string, string>> = {};
const actors: string[] = [];

async function login(name: string, principal: Pick<Principal, "role" | "orgUnitId" | "dataScope">) {
  const session = await realSession({ name: `IT rm ${name}`, ...principal });
  actors.push(session.principal.id);
  headers[name] = sessionHeaders(session, sessionCookieValue(session));
}
const post = (who: string, agentRoleCode: string) =>
  app.inject({ method: "POST", url: "/admin/api/role-mappings", headers: headers[who]!, payload: { agentRoleCode, agentRoleName: "IT rm", localRole: "user" } });
const mappings = (c: string) => query("SELECT agent_role_code, local_role FROM oidc_role_mappings WHERE agent_role_code = ?", [c]);
const audits = async () => Number((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE outcome = 'success' AND action = 'role_mapping.upsert' AND actor_id IN (${actors.map(() => "?").join(",")})`, actors))[0]!.n);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await login("paOrg", { role: "platform_admin", orgUnitId: ROOT, dataScope: "org" });
  await login("paAll", { role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  await login("oaAll", { role: "org_admin", orgUnitId: ROOT, dataScope: "all" });
});

afterAll(async () => {
  if (actors.length) await execute(`DELETE FROM audit_logs WHERE actor_id IN (${actors.map(() => "?").join(",")})`, actors);
  await execute("DELETE FROM oidc_role_mappings WHERE agent_role_code LIKE ?", [`it-rm-%-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("P3 role-mappings write needs dataScope=all (P0-03 pattern)", () => {
  it("platform_admin with dataScope org -> 403 POL-2001, nothing written, nothing audited", async () => {
    const res = await post("paOrg", code("org"));
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("POL-2001");
    expect(await mappings(code("org"))).toEqual([]);
    expect(await audits()).toBe(0);
  });

  it("the 403 comes before body validation (invalid body still 403)", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/role-mappings", headers: headers.paOrg!, payload: { agentRoleCode: 1 } });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("org_admin (no sso.manage) stays 403 even with dataScope all", async () => {
    expect((await post("oaAll", code("oa"))).statusCode).toBe(403);
    expect(await mappings(code("oa"))).toEqual([]);
  });

  it("platform_admin with dataScope all -> 200, written and audited", async () => {
    const res = await post("paAll", code("all"));
    expect(res.statusCode, res.body).toBe(200);
    expect(await mappings(code("all"))).toEqual([{ agent_role_code: code("all"), local_role: "user" }]);
    expect(await audits()).toBe(1);
  });
});
