import { updateConfiguration, type ConfigurationWrite } from "../configuration-revision.js";
import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query } from "../db.js";

/** Row shape shared by the schedule list and GET /schedules/:id, so both serialize identically. */
const SCHEDULE_LIST_SELECT = "SELECT s.*, a.name AS agent_name FROM schedules s JOIN agents a ON a.id = s.agent_id";

export const schedulesRepo = {
  // Schedules
  async listSchedules(): Promise<Record<string, unknown>[]> {
    return query(`${SCHEDULE_LIST_SELECT} ORDER BY s.created_at DESC`);
  },
  /** One schedule in exactly the list row shape (same columns, same agent join). */
  async getScheduleListRow(id: string): Promise<Record<string, unknown> | null> {
    return one(`${SCHEDULE_LIST_SELECT} WHERE s.id = ?`, [id]);
  },
  async getSchedule(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM schedules WHERE id = ?", [id]);
  },
  async createSchedule(input: { key: string; name: string; agentId: string; orgUnitId: string | null; subjectType: string; subjectId: string; serviceAccountId?: string | null; cron: string; timezone: string; input: unknown; status?: string; nextRunAt?: Date | null; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("sch");
    await execute(
      "INSERT INTO schedules (id, `key`, name, agent_id, org_unit_id, subject_type, subject_id, service_account_id, cron, timezone, input_json, status, next_run_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.agentId, input.orgUnitId, input.subjectType, input.subjectId, input.serviceAccountId ?? null, input.cron, input.timezone, json(input.input), input.status ?? "disabled", input.nextRunAt ?? null, input.createdBy ?? null],
    );
    return id;
  },
  async updateSchedule(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["name","cron","timezone","input_json","status","next_run_at","last_run_id","service_account_id"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key.endsWith("_json") ? json(value) : value]));
    return updateConfiguration("schedules", id, values, options);
  },
  async dueSchedules(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM schedules WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP(3)) ORDER BY next_run_at LIMIT 20");
  },
  /** Successful trigger: advance, remember the run, and reset the consecutive-failure counter. */
  async markScheduleRun(id: string, nextRunAt: Date, lastRunId: string, revision?: number): Promise<void> {
    await execute("UPDATE schedules SET next_run_at = ?, last_run_id = ?, failure_count = 0, last_error_code = NULL WHERE id = ? AND revision = COALESCE(?, revision)", [nextRunAt, lastRunId, id, revision ?? null]);
  },
  /** Failed trigger: count it, keep the error code, and stop scheduling (status 'disabled', next_run_at NULL). */
  async recordScheduleFailure(id: string, errorCode: string, revision?: number): Promise<void> {
    await execute(
      "UPDATE schedules SET status = 'disabled', revision = revision + 1, next_run_at = NULL, failure_count = failure_count + 1, last_error_code = ? WHERE id = ? AND revision = COALESCE(?, revision)",
      [errorCode.slice(0, 16), id, revision ?? null],
    );
  },
  /**
   * Transient trigger failure (e.g. database error while resolving the identity): count it and keep the code, but the
   * schedule stays active; only this occurrence is skipped (next_run_at moves to the next cron slot).
   */
  async recordScheduleTriggerError(id: string, errorCode: string, nextRunAt: Date | null, revision?: number): Promise<void> {
    await execute(
      "UPDATE schedules SET next_run_at = ?, failure_count = failure_count + 1, last_error_code = ? WHERE id = ? AND revision = COALESCE(?, revision)",
      [nextRunAt, errorCode.slice(0, 16), id, revision ?? null],
    );
  },
  async advanceScheduleClock(id: string, nextRunAt: Date, revision: number): Promise<void> {
    await execute("UPDATE schedules SET next_run_at = ? WHERE id = ? AND revision = ?", [nextRunAt, id, revision]);
  },
  /** True while a run triggered by this schedule is still in flight (used by concurrency_policy = 'skip'). */
  async hasInFlightScheduleRun(scheduleId: string): Promise<boolean> {
    const row = await one<{ id: string }>(
      "SELECT id FROM runs WHERE trigger_type = 'schedule' AND trigger_ref = ? AND status IN ('queued','running','waiting_approval') LIMIT 1",
      [scheduleId],
    );
    return Boolean(row);
  },
};
