import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// AB / I-SCOPE-13 (a_b vs axb -> 404), I-SCOPE-14 (/a/b vs /a/bc, child /a/b/c still visible): orgSubtreeIds must treat the department path literally. "_" and "%" in a key are not wildcards,
// and "/x/b" must not match its sibling "/x/bc" (prefix + separator).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const P = `/it-like-${suffix}`;
const ORG = {
  parent: { id: id26("ITLP"), parent: ROOT, key: `it-like-${suffix}`, path: `${P}/` },
  a_b: { id: id26("ITLU"), parent: "parent", key: "a_b", path: `${P}/a_b/` },
  axb: { id: id26("ITLX"), parent: "parent", key: "axb", path: `${P}/axb/` },
  pct: { id: id26("ITLC"), parent: "parent", key: "a%", path: `${P}/a%/` },
  azz: { id: id26("ITLZ"), parent: "parent", key: "azz", path: `${P}/azz/` },
  bsl: { id: id26("ITLS"), parent: "parent", key: "q\\", path: `${P}/q\\/` },
  qx: { id: id26("ITLQ"), parent: "parent", key: "q\\x", path: `${P}/q\\x/` },
  // Paths stored without a trailing separator: /x/b must not swallow /x/bc, but must include /x/b/c.
  b: { id: id26("ITLB"), parent: "parent", key: "b", path: `${P}/b` },
  bc: { id: id26("ITLD"), parent: "parent", key: "bc", path: `${P}/bc` },
  bChild: { id: id26("ITLE"), parent: "b", key: "c", path: `${P}/b/c` },
} as const;
type Name = keyof typeof ORG;
let app: FastifyInstance;
const users: Partial<Record<Name, string>> = {};
const adminHeaders: Partial<Record<Name, Record<string, string>>> = {};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [name, org] of Object.entries(ORG) as Array<[Name, (typeof ORG)[Name]]>) {
    const parentId = org.parent === ROOT ? ROOT : ORG[org.parent as Name].id;
    await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [org.id, parentId, `${org.key}-${suffix}`.slice(0, 64), `IT like ${name}`, org.path]);
    users[name] = await repos.createUser({ email: `it-like-${name.toLowerCase()}-${suffix}@forge.local`, username: `it-like-${name.toLowerCase()}-${suffix}`, displayName: `IT like ${name}`, role: "user", dataScope: "self", orgUnitId: org.id });
  }
  for (const name of ["a_b", "pct", "bsl", "b", "bc"] as Name[]) {
    const s = await realSession({ role: "org_admin", orgUnitId: ORG[name].id, dataScope: "org" });
    adminHeaders[name] = sessionHeaders(s, sessionCookieValue(s));
  }
});

afterAll(async () => {
  for (const id of Object.values(users)) {
    await execute("DELETE FROM audit_logs WHERE resource_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  await cleanupRealSessions();
  await execute("DELETE FROM org_units WHERE id = ?", [ORG.bChild.id]);
  await execute(`DELETE FROM org_units WHERE id IN (${Object.keys(ORG).map(() => "?").join(", ")}) AND id <> ?`, [...Object.values(ORG).map((o) => o.id), ORG.parent.id]);
  await execute("DELETE FROM org_units WHERE id = ?", [ORG.parent.id]);
  await app?.close();
});

describe("orgSubtreeIds is literal (AB, I-SCOPE-13 / I-SCOPE-14)", () => {
  const cases: Array<[Name, Name[], Name[]]> = [
    ["a_b", ["a_b"], ["axb"]],
    ["pct", ["pct"], ["azz", "a_b", "axb"]],
    ["bsl", ["bsl"], ["qx"]],
    ["b", ["b", "bChild"], ["bc"]],
    ["bc", ["bc"], ["b", "bChild"]],
    ["parent", ["parent", "a_b", "axb", "b", "bc", "bChild"], []],
  ];
  for (const [root, inside, outside] of cases) {
    it(`subtree of ${root}: includes ${inside.join(",")}; excludes ${outside.join(",") || "-"}`, async () => {
      const ids = await repos.orgSubtreeIds(ORG[root].id);
      for (const name of inside) expect(ids).toContain(ORG[name].id);
      for (const name of outside) expect(ids).not.toContain(ORG[name].id);
    });
  }
});

describe("I-SCOPE-13: org_admin of a_b cannot read axb users", () => {
  it("PATCH axb user -> 404, same as a missing user; own user -> 200", async () => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/users/${users.axb}`, headers: await configurationHeaders(`/admin/api/users/${users.axb}`, adminHeaders.a_b!), payload: { status: "disabled" } });
    expect(res.statusCode, res.body).toBe(404);
    const missing = await app.inject({ method: "PATCH", url: "/admin/api/users/usr_nonexistent00000000000", headers: await configurationHeaders("/admin/api/users/usr_nonexistent00000000000", adminHeaders.a_b!), payload: { status: "disabled" } });
    expect(res.body.replace(/"requestId":"[^"]+"/, "")).toBe(missing.body.replace(/"requestId":"[^"]+"/, ""));
    expect((await repos.getUserById(users.axb!))!.status).toBe("active");
    const own = await app.inject({ method: "PATCH", url: `/admin/api/users/${users.a_b}`, headers: await configurationHeaders(`/admin/api/users/${users.a_b}`, adminHeaders.a_b!), payload: { status: "active" } });
    expect(own.statusCode, own.body).toBe(200);
  });

  for (const [admin, hidden] of [["a_b", "axb"], ["pct", "azz"], ["bsl", "qx"], ["b", "bc"]] as Array<[Name, Name]>) {
    it(`GET /admin/api/users as ${admin} admin does not list ${hidden}`, async () => {
      const res = await app.inject({ method: "GET", url: "/admin/api/users", headers: adminHeaders[admin]! });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as { items: Array<{ id: string }> }).items.map((u) => u.id);
      expect(ids).toContain(users[admin]);
      expect(ids).not.toContain(users[hidden]);
    });
  }

  it("I-SCOPE-14: org_admin of /x/b sees /x/b/c but not /x/bc; org_admin of /x/bc does not see /x/b", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/users", headers: adminHeaders.b! });
    const ids = (res.json() as { items: Array<{ id: string }> }).items.map((u) => u.id);
    expect(ids).toContain(users.b);
    expect(ids).toContain(users.bChild);
    expect(ids).not.toContain(users.bc);
    const sibling = await app.inject({ method: "GET", url: "/admin/api/users", headers: adminHeaders.bc! });
    const siblingIds = (sibling.json() as { items: Array<{ id: string }> }).items.map((u) => u.id);
    expect(siblingIds).toContain(users.bc);
    expect(siblingIds).not.toContain(users.b);
    expect(siblingIds).not.toContain(users.bChild);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/users/${users.bc}`, headers: await configurationHeaders(`/admin/api/users/${users.bc}`, adminHeaders.b!), payload: { status: "active" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/users/${users.bChild}`, headers: await configurationHeaders(`/admin/api/users/${users.bChild}`, adminHeaders.b!), payload: { status: "active" } })).statusCode).toBe(200);
  });
});

describe("I-SCOPE-14: ancestor-active check uses the same separator rule", () => {
  it("disabling /x/b deactivates /x/b and /x/b/c users but not the /x/bc sibling", async () => {
    await execute("UPDATE org_units SET status = 'disabled' WHERE id = ?", [ORG.b.id]);
    try {
      expect(await repos.getActiveUserById(users.b!)).toBeNull();
      expect(await repos.getActiveUserById(users.bChild!)).toBeNull();
      expect(await repos.getActiveUserById(users.bc!)).not.toBeNull();
    } finally {
      await execute("UPDATE org_units SET status = 'active' WHERE id = ?", [ORG.b.id]);
    }
  });
});
