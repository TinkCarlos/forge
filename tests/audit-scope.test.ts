import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { auditScopeFromGrants, scopeCoversOrg, type AuditGrant } from "../packages/governance/src/audit-scope.js";
import { AUDIT_ORG_SOURCES, AUDIT_PLATFORM_RESOURCES, buildAuditListQuery, userUpdateAuditEntries } from "../packages/store/src/repositories/audit-scope-sql.js";

// I-SCOPE-13/14 plan A: audit rows carry the resource's department (written at write time) and the list is filtered by
// the generic dataScope rules (permissions.md 4.3/4.4), never by role name and never by the actor's current department.
const subtree = async (orgId: string | null): Promise<string[]> => (orgId === "A" ? ["A", "A1"] : orgId ? [orgId] : []);
const user = { type: "user" as const, id: "U1", orgUnitId: "A" };

describe("auditScopeFromGrants", () => {
  it("all absorbs every other scope (also for an org_admin granted all)", async () => {
    expect(await auditScopeFromGrants(user, [{ scope: "org_tree" }, { scope: "all" }], subtree)).toEqual({ all: true });
  });
  it("org_tree -> caller subtree", async () => {
    expect(await auditScopeFromGrants(user, [{ scope: "org_tree" }], subtree)).toEqual({ all: false, orgIds: ["A", "A1"], actors: [] });
  });
  it("custom_orgs -> the listed departments", async () => {
    expect(await auditScopeFromGrants(user, [{ scope: "custom_orgs", orgIds: ["B", "C"] }], subtree)).toEqual({ all: false, orgIds: ["B", "C"], actors: [] });
  });
  it("self -> rows the caller produced", async () => {
    expect(await auditScopeFromGrants(user, [{ scope: "self" }], subtree)).toEqual({ all: false, orgIds: [], actors: [{ type: "user", id: "U1" }] });
  });
  it("several grants -> union, deduplicated", async () => {
    const grants: AuditGrant[] = [{ scope: "org_tree" }, { scope: "custom_orgs", orgIds: ["A1", "B"] }, { scope: "self" }];
    expect(await auditScopeFromGrants(user, grants, subtree)).toEqual({ all: false, orgIds: ["A", "A1", "B"], actors: [{ type: "user", id: "U1" }] });
  });
  it("nothing granted / org_tree without a department / app -> empty", async () => {
    expect(await auditScopeFromGrants(user, [], subtree)).toEqual({ all: false, orgIds: [], actors: [] });
    expect(await auditScopeFromGrants({ ...user, orgUnitId: null }, [{ scope: "org_tree" }], subtree)).toEqual({ all: false, orgIds: [], actors: [] });
    expect(await auditScopeFromGrants(user, [{ scope: "app" }], subtree)).toEqual({ all: false, orgIds: [], actors: [] });
  });
});

describe("buildAuditListQuery", () => {
  it("all -> no WHERE (NULL-department rows included)", () => {
    const q = buildAuditListQuery({ all: true }, 50);
    expect(q?.sql).not.toMatch(/WHERE/);
    expect(q?.params).toEqual([50]);
  });
  it("departments + self -> OR of IN and actor match; never joins users", () => {
    const q = buildAuditListQuery({ all: false, orgIds: ["A", "A1"], actors: [{ type: "user", id: "U1" }] }, 10)!;
    expect(q.sql).toMatch(/org_unit_id IN \(\?, \?\)/);
    expect(q.sql).toMatch(/actor_type = \? AND actor_id = \?/);
    expect(q.sql).not.toMatch(/JOIN/i);
    expect(q.params).toEqual(["A", "A1", "user", "U1", 10]);
  });
  it("empty scope -> null (caller returns [] without querying)", () => {
    expect(buildAuditListQuery({ all: false, orgIds: [], actors: [] }, 10)).toBeNull();
  });
  it("limit is clamped to 1..500", () => {
    expect(buildAuditListQuery({ all: true }, 9999)?.params).toEqual([500]);
    expect(buildAuditListQuery({ all: true }, 0)?.params).toEqual([1]);
    expect(buildAuditListQuery({ all: true }, Number.NaN)?.params).toEqual([100]);
  });
});

describe("audit department sources", () => {
  it("every resourceType written by the API or transactional repositories has a scope classification", () => {
    const dir = path.resolve(import.meta.dirname, "../apps/api/src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    walk(path.resolve(import.meta.dirname, "../packages/store/src/repositories"));
    const types = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/writeAudit\(\s*session,\s*"[^"]+",\s*"([a-z_]+)"/g)) types.add(m[1]!);
      for (const m of src.matchAll(/configurationWrite\(\s*request,\s*session,\s*"[^"]+",\s*"([a-z_]+)"/g)) types.add(m[1]!);
      for (const m of src.matchAll(/resourceType:\s*"([a-z_]+)"/g)) types.add(m[1]!);
    }
    expect(types.size).toBeGreaterThanOrEqual(18);
    for (const t of types) expect(t in AUDIT_ORG_SOURCES || AUDIT_PLATFORM_RESOURCES.includes(t), t).toBe(true);
    for (const t of ["webhook_delivery", "api_key", "api_app", "approval", "agent_version", "user", "run", "schedule", "service_account", "agent"]) {
      expect(AUDIT_ORG_SOURCES[t], t).toBeTruthy();
    }
    for (const sql of Object.values(AUDIT_ORG_SOURCES)) expect(sql).not.toMatch(/\busers\b.*actor|actor_id/);
  });
});

describe("userUpdateAuditEntries", () => {
  it("same department -> one user.update in that department", () => {
    expect(userUpdateAuditEntries("A", "A", { role: "builder" })).toEqual([{ action: "user.update", orgUnitId: "A", details: { role: "builder" } }]);
  });
  it("department changed -> main row in the new department + user.org_transfer_out in the old one", () => {
    expect(userUpdateAuditEntries("A", "B", { role: "builder" })).toEqual([
      { action: "user.update", orgUnitId: "B", details: { role: "builder", fromOrgUnitId: "A", toOrgUnitId: "B" } },
      { action: "user.org_transfer_out", orgUnitId: "A", details: { fromOrgUnitId: "A", toOrgUnitId: "B" } },
    ]);
  });
});

describe("scopeCoversOrg (K-05 write check, same scope object as the audit filter)", () => {
  it("all writes everything, including resources without a department", () => {
    expect(scopeCoversOrg({ all: true }, "X")).toBe(true);
    expect(scopeCoversOrg({ all: true }, null)).toBe(true);
  });
  it("org_tree writes its own department and the subtree, not the parent or a sibling", async () => {
    const scope = await auditScopeFromGrants(user, [{ scope: "org_tree" }], subtree);
    expect(scopeCoversOrg(scope, "A")).toBe(true);
    expect(scopeCoversOrg(scope, "A1")).toBe(true);
    expect(scopeCoversOrg(scope, "ROOT")).toBe(false);
    expect(scopeCoversOrg(scope, "B")).toBe(false);
  });
  it("a resource without a department needs dataScope=all", async () => {
    const scope = await auditScopeFromGrants(user, [{ scope: "org_tree" }], subtree);
    expect(scopeCoversOrg(scope, null)).toBe(false);
    expect(scopeCoversOrg(scope, "")).toBe(false);
  });
  it("self covers no department; custom_orgs covers exactly the listed ones", async () => {
    expect(scopeCoversOrg(await auditScopeFromGrants(user, [{ scope: "self" }], subtree), "A")).toBe(false);
    const custom = await auditScopeFromGrants(user, [{ scope: "custom_orgs", orgIds: ["B"] }], subtree);
    expect(scopeCoversOrg(custom, "B")).toBe(true);
    expect(scopeCoversOrg(custom, "A")).toBe(false);
  });
});
