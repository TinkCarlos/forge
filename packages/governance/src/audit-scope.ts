// I-SCOPE-13/14 plan A: which audit rows a principal may read. Pure (no DB import) so it is unit-testable.
// Generic dataScope rules (permissions.md 4.3 / 4.4), never the role name:
//   all -> no row restriction (NULL-department rows included); org_tree -> org_unit_id IN (subtree);
//   custom_orgs -> org_unit_id IN (orgIds); self -> rows the principal produced (actor match).
// Several grants -> union; all absorbs the rest; nothing granted -> empty.
// The department is the one recorded on the audit row (the resource's department at write time); the actor's
// current department is never consulted.

export type AuditGrant =
  | { scope: "all" }
  | { scope: "org_tree" }
  | { scope: "custom_orgs"; orgIds: string[] }
  | { scope: "self" }
  | { scope: "app" };

export type AuditScope =
  | { all: true }
  | { all: false; orgIds: string[]; actors: Array<{ type: string; id: string }> };

export interface AuditSubject {
  type: "user" | "service" | "app";
  id: string;
  orgUnitId: string | null;
}

export async function auditScopeFromGrants(
  subject: AuditSubject,
  grants: AuditGrant[],
  subtreeIds: (orgId: string | null) => Promise<string[]>,
): Promise<AuditScope> {
  if (grants.some((grant) => grant.scope === "all")) return { all: true };
  const orgIds = new Set<string>();
  const actors: Array<{ type: string; id: string }> = [];
  for (const grant of grants) {
    if (grant.scope === "org_tree") {
      for (const id of await subtreeIds(subject.orgUnitId)) orgIds.add(id);
    } else if (grant.scope === "custom_orgs") {
      for (const id of grant.orgIds) if (typeof id === "string" && id) orgIds.add(id);
    } else if (grant.scope === "self") {
      if (subject.type !== "app" && !actors.some((a) => a.type === subject.type && a.id === subject.id)) actors.push({ type: subject.type, id: subject.id });
    }
    // "app": API apps never reach the audit API (admin session only) -> contributes nothing.
  }
  return { all: false, orgIds: [...orgIds], actors };
}
