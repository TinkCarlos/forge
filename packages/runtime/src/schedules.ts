import { CronExpressionParser } from "cron-parser";
import { ForgeError, type DataScope, type Principal, type Role } from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";
import { createQueuedRun } from "./loop.js";

/** Schedule paused because its identity/Agent is unusable (service account disabled, Agent disabled/unpublished, no permission). */
export const SCHEDULE_PAUSED_CODE = "SCD-4801";
/** Any other trigger failure (bad cron, run creation error, ...). */
export const SCHEDULE_TRIGGER_FAILED_CODE = "SCD-4803";

export type ScheduleTriggerResult =
  | { kind: "run"; runId: string }
  | { kind: "skipped"; reason: "concurrency" }
  | { kind: "paused"; code: string }
  | { kind: "failed"; code: string };

/** Triggers one due schedule row. Failures are recorded on the schedule (failure_count, last_error_code) and stop it. */
export async function triggerSchedule(schedule: Record<string, unknown>, now = new Date()): Promise<ScheduleTriggerResult> {
  const scheduleId = String(schedule.id);
  try {
    const agentId = String(schedule.agent_id);
    const agent = await repos.getAgent(agentId);
    if (!agent || agent.status !== "active" || !agent.published_version_id) {
      await repos.recordScheduleFailure(scheduleId, SCHEDULE_PAUSED_CODE);
      return { kind: "paused", code: SCHEDULE_PAUSED_CODE };
    }
    let principal: Principal;
    if (schedule.service_account_id) {
      // Run with the service account's own identity, role and data scope; a disabled/missing account pauses the schedule.
      const account = await repos.getServiceAccount(String(schedule.service_account_id));
      if (!account || account.status !== "active") {
        await repos.recordScheduleFailure(scheduleId, SCHEDULE_PAUSED_CODE);
        return { kind: "paused", code: SCHEDULE_PAUSED_CODE };
      }
      principal = {
        type: "service",
        id: account.id,
        name: account.name,
        role: account.role as Role,
        orgUnitId: account.org_unit_id,
        dataScope: account.data_scope as DataScope,
      };
    } else {
      // Legacy schedule (created before service accounts were required): unchanged identity until it is rebound.
      principal = {
        type: "service",
        id: String(schedule.subject_id),
        name: String(schedule.name),
        role: "user",
        orgUnitId: schedule.org_unit_id ? String(schedule.org_unit_id) : null,
        dataScope: "org",
      };
    }
    const nextRunAt = () =>
      CronExpressionParser.parse(String(schedule.cron), { currentDate: now, tz: String(schedule.timezone ?? "Asia/Shanghai") }).next().toDate();
    // concurrency_policy: only 'skip' (the default) is implemented; other values currently behave as before (always enqueue).
    if (String(schedule.concurrency_policy ?? "skip") === "skip" && (await repos.hasInFlightScheduleRun(scheduleId))) {
      await repos.updateSchedule(scheduleId, { next_run_at: nextRunAt() });
      return { kind: "skipped", reason: "concurrency" };
    }
    const runId = await createQueuedRun({
      agentId,
      versionId: agent.published_version_id,
      principal,
      input: parseJsonValue(schedule.input_json, { text: `Scheduled run: ${String(schedule.name)}` }),
      triggerType: "schedule",
      triggerRef: scheduleId,
    });
    await repos.markScheduleRun(scheduleId, nextRunAt(), runId);
    return { kind: "run", runId };
  } catch (error) {
    const code = error instanceof ForgeError ? error.code : SCHEDULE_TRIGGER_FAILED_CODE;
    await repos.recordScheduleFailure(scheduleId, code);
    return { kind: "failed", code };
  }
}

export async function tickSchedules(now = new Date()): Promise<void> {
  const due = await repos.dueSchedules();
  for (const schedule of due) {
    await triggerSchedule(schedule, now);
  }
}
