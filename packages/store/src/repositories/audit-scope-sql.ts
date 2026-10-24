// I-SCOPE-13/14 plan A: pure SQL helpers for the audit department (no DB import, unit-tested).

export type AuditListScope =
  | { all: true }
  | { all: false; orgIds: string[]; actors: Array<{ type: string; id: string }> };

/**
 * resourceType -> SQL returning the resource's own department (one row, column org_unit_id), parameter = resourceId.
 * Evaluated when the audit row is written and stored on the row; never the actor's department.
 */
export const AUDIT_ORG_SOURCES: Record<string, string> = {
  agent: "SELECT owner_org_unit_id AS org_unit_id FROM agents WHERE id = ?",
  agent_version: "SELECT a.owner_org_unit_id AS org_unit_id FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.id = ?",
  run: "SELECT org_unit_id FROM runs WHERE id = ?",
  approval: "SELECT r.org_unit_id AS org_unit_id FROM approvals ap JOIN runs r ON r.id = ap.run_id WHERE ap.id = ?",
  schedule: "SELECT org_unit_id FROM schedules WHERE id = ?",
  service_account: "SELECT org_unit_id FROM service_accounts WHERE id = ?",
  user: "SELECT org_unit_id FROM users WHERE id = ?",
  api_app: "SELECT owner_org_unit_id AS org_unit_id FROM api_apps WHERE id = ?",
  api_key: "SELECT p.owner_org_unit_id AS org_unit_id FROM api_keys k JOIN api_apps p ON p.id = k.app_id WHERE k.id = ?",
  webhook_delivery: "SELECT p.owner_org_unit_id AS org_unit_id FROM webhook_deliveries d JOIN api_apps p ON p.id = d.app_id WHERE d.id = ?",
};

/** Platform-level configuration without a department: rows stay NULL (visible to dataScope all only). */
export const AUDIT_PLATFORM_RESOURCES: readonly string[] = [
  "mcp_server",
  "llm_provider",
  "llm_model",
  "skill",
  "skill_version",
  "tool_source",
  "plugin",
  "oidc_role_mapping",
];

export function clampAuditLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}

/** null = the scope is empty, return [] without querying. Never joins users / the actor's department. */
export function buildAuditListQuery(scope: AuditListScope, limit: number): { sql: string; params: unknown[] } | null {
  const n = clampAuditLimit(limit);
  if (scope.all) return { sql: "SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?", params: [n] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.orgIds.length) {
    clauses.push(`org_unit_id IN (${scope.orgIds.map(() => "?").join(", ")})`);
    params.push(...scope.orgIds);
  }
  for (const actor of scope.actors) {
    clauses.push("(actor_type = ? AND actor_id = ?)");
    params.push(actor.type, actor.id);
  }
  if (!clauses.length) return null;
  return { sql: `SELECT * FROM audit_logs WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC, id DESC LIMIT ?`, params: [...params, n] };
}

export interface UserUpdateAuditEntry {
  action: "user.update" | "user.org_transfer_out";
  orgUnitId: string | null;
  details: Record<string, unknown>;
}

/** user.update goes to the new department; a real department change adds user.org_transfer_out in the old one. */
export function userUpdateAuditEntries(before: string | null, after: string | null, details: Record<string, unknown>): UserUpdateAuditEntry[] {
  if (before === after) return [{ action: "user.update", orgUnitId: after, details }];
  const move = { fromOrgUnitId: before, toOrgUnitId: after };
  return [
    { action: "user.update", orgUnitId: after, details: { ...details, ...move } },
    { action: "user.org_transfer_out", orgUnitId: before, details: move },
  ];
}
