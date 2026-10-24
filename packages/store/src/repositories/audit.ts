import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query } from "../db.js";
import { AUDIT_ORG_SOURCES, assertDeleteAuditOrgUnit, buildAuditListQuery, type AuditListScope } from "./audit-scope-sql.js";

/** I-SCOPE plan A: the resource's own department at write time (NULL for platform-level resources or on lookup failure). */
async function resolveAuditOrgUnit(resourceType: string, resourceId: string | null | undefined): Promise<string | null> {
  const sql = AUDIT_ORG_SOURCES[resourceType];
  if (!sql || !resourceId) return null;
  try {
    const row = await one<{ org_unit_id: string | null }>(sql, [resourceId]);
    return row?.org_unit_id ?? null;
  } catch {
    // Never lose the audit row: an unresolved department only narrows visibility (dataScope all still sees it).
    return null;
  }
}

export const auditRepo = {
  // Audit / stats / settings
  /**
   * Writes one audit row. orgUnitId = the resource's department: pass it when known (including an explicit null);
   * when omitted it is resolved from resourceType/resourceId (AUDIT_ORG_SOURCES), never from the actor.
   * Delete-class actions (DELETE_CLASS_AUDIT_ACTION) must pass it explicitly; omitting it throws.
   */
  async audit(input: { actorType: string; actorId?: string | null; action: string; resourceType: string; resourceId?: string | null; details?: unknown; orgUnitId?: string | null }): Promise<void> {
    assertDeleteAuditOrgUnit(input);
    const orgUnitId = input.orgUnitId !== undefined ? input.orgUnitId : await resolveAuditOrgUnit(input.resourceType, input.resourceId);
    await execute(
      "INSERT INTO audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, org_unit_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [ulidWithPrefix("aud"), input.actorType, input.actorId ?? null, input.action, input.resourceType, input.resourceId ?? null, orgUnitId, json(input.details ?? {})],
    );
  },
  /** I-SCOPE-13/14: the scope is mandatory (permissions.md 4.5, no unfiltered list). Build it with governance auditFilterFor. */
  async listAudit(scope: AuditListScope, limit = 100): Promise<Record<string, unknown>[]> {
    const built = buildAuditListQuery(scope, limit);
    if (!built) return [];
    return query(built.sql, built.params);
  },
  async stats(): Promise<Record<string, unknown>> {
    const runs = await query<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM runs GROUP BY status");
    const agents = await one<{ count: number }>("SELECT COUNT(*) AS count FROM agents WHERE deleted_at IS NULL");
    const approvals = await one<{ count: number }>("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'");
    const today = await one<{ count: number }>("SELECT COUNT(*) AS count FROM runs WHERE created_at >= CURRENT_DATE()");
    return {
      runsByStatus: Object.fromEntries(runs.map((row) => [row.status, Number(row.count)])),
      agents: Number(agents?.count ?? 0),
      pendingApprovals: Number(approvals?.count ?? 0),
      runsToday: Number(today?.count ?? 0),
    };
  },
  async getSetting(key: string): Promise<unknown | null> {
    const row = await one<{ value_json: unknown }>("SELECT value_json FROM settings WHERE `key` = ?", [key]);
    return row?.value_json ?? null;
  },
  async setSetting(key: string, value: unknown): Promise<void> {
    await execute("INSERT INTO settings (`key`, value_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)", [key, json(value)]);
  },
};
