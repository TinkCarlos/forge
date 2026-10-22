import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query } from "../db.js";

export const schedulesRepo = {
  // Schedules
  async listSchedules(): Promise<Record<string, unknown>[]> {
    return query("SELECT s.*, a.name AS agent_name FROM schedules s JOIN agents a ON a.id = s.agent_id ORDER BY s.created_at DESC");
  },
  async getSchedule(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM schedules WHERE id = ?", [id]);
  },
  async createSchedule(input: { key: string; name: string; agentId: string; orgUnitId: string | null; subjectType: string; subjectId: string; cron: string; timezone: string; input: unknown; status?: string; nextRunAt?: Date | null; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("sch");
    await execute(
      "INSERT INTO schedules (id, `key`, name, agent_id, org_unit_id, subject_type, subject_id, cron, timezone, input_json, status, next_run_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.agentId, input.orgUnitId, input.subjectType, input.subjectId, input.cron, input.timezone, json(input.input), input.status ?? "disabled", input.nextRunAt ?? null, input.createdBy ?? null],
    );
    return id;
  },
  async updateSchedule(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "cron", "timezone", "input_json", "status", "next_run_at", "last_run_id"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async dueSchedules(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM schedules WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP(3)) ORDER BY next_run_at LIMIT 20");
  },
  async markScheduleRun(id: string, nextRunAt: Date, lastRunId: string): Promise<void> {
    await execute("UPDATE schedules SET next_run_at = ?, last_run_id = ? WHERE id = ?", [nextRunAt, lastRunId, id]);
  },
};
