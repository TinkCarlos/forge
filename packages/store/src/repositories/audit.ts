import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query } from "../db.js";

export const auditRepo = {
  // Audit / stats / settings
  async audit(input: { actorType: string; actorId?: string | null; action: string; resourceType: string; resourceId?: string | null; details?: unknown }): Promise<void> {
    await execute(
      "INSERT INTO audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ulidWithPrefix("aud"), input.actorType, input.actorId ?? null, input.action, input.resourceType, input.resourceId ?? null, json(input.details ?? {})],
    );
  },
  async listAudit(limit = 100): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?", [Math.min(limit, 500)]);
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
