import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as identity from "@forge/identity";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (architect 4:51, QA 714b3f3 §4): POST /admin/api/role-mappings only accepts a known local role (enum, 400
// CFG-8501, nothing written), and SSO role mapping ignores a stored mapping whose local_role is not a known role
// (a legacy / hand-edited row). Before, an unknown role got priority index -1 and won over every valid mapping.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const code = (n: string) => `it-rl-${n}-${suffix}`;
const ROLES = ["platform_admin", "org_admin", "builder", "operator", "auditor", "user"];
let app: FastifyInstance;
let headers: Record<string, string> = {};
type MapRoles = (roles: Array<{ code: string; name: string }>) => Promise<string | null>;
const mapRoles = (identity as unknown as { mapRoles: MapRoles }).mapRoles;
const post = (localRole: unknown, c = code("api")) =>
  app.inject({ method: "POST", url: "/admin/api/role-mappings", headers, payload: { agentRoleCode: c, agentRoleName: "IT rl", localRole } });
const stored = (c: string) => query<{ local_role: string }>("SELECT local_role FROM oidc_role_mappings WHERE agent_role_code = ?", [c]);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT rl", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  // Legacy rows written before the enum existed (bypass the API on purpose).
  await repos.upsertRoleMapping(code("typo"), "", "platfrom_admin");
  await repos.upsertRoleMapping(code("blank"), "", "");
  await repos.upsertRoleMapping(code("ok"), "", "operator");
});

afterAll(async () => {
  await execute("DELETE FROM oidc_role_mappings WHERE agent_role_code LIKE ?", [`it-rl-%-${suffix}`]);
  await execute("DELETE FROM audit_logs WHERE action = 'role_mapping.upsert' AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentRoleCode')) LIKE ?", [`it-rl-%-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("P2 role-mappings localRole enum", () => {
  for (const bad of ["platfrom_admin", "PLATFORM_ADMIN", "admin", "", " user", "root"]) {
    it(`localRole ${JSON.stringify(bad)} -> 400 CFG-8501, nothing written`, async () => {
      const c = code(`bad${randomBytes(2).toString("hex")}`);
      const res = await post(bad, c);
      expect([res.statusCode, (res.json() as { error?: { code?: string } }).error?.code], res.body).toEqual([400, "CFG-8501"]);
      expect(await stored(c)).toEqual([]);
    });
  }

  it.each(ROLES)("localRole %s -> 200 and stored", async (role) => {
    const c = code(`good-${role}`);
    const res = await post(role, c);
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(c)).map((r) => r.local_role)).toEqual([role]);
  });
});

describe("P2 mapRoles ignores mappings to unknown local roles", () => {
  it("is exported for tests", () => expect(typeof mapRoles).toBe("function"));

  it("a misspelled mapping does not override a valid one (either order)", async () => {
    expect(await mapRoles([{ code: code("typo"), name: "" }, { code: code("ok"), name: "" }])).toBe("operator");
    expect(await mapRoles([{ code: code("ok"), name: "" }, { code: code("typo"), name: "" }])).toBe("operator");
    expect(await mapRoles([{ code: code("blank"), name: "" }, { code: code("ok"), name: "" }])).toBe("operator");
  });

  it("only an unknown mapping behaves like no mapping at all (never returns the unknown value)", async () => {
    const none = await mapRoles([{ code: code("unmapped"), name: "" }]);
    const typo = await mapRoles([{ code: code("typo"), name: "" }]);
    const blank = await mapRoles([{ code: code("blank"), name: "" }]);
    expect(typo).toBe(none);
    expect(blank).toBe(none);
    expect(none === null || ROLES.includes(none)).toBe(true);
  });
});
