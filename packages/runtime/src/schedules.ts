import { CronExpressionParser } from "cron-parser";
import { ForgeError, type Principal } from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";
import { createQueuedRun } from "./loop.js";

/** Schedule paused because its identity/Agent is unusable (service account disabled, Agent disabled/unpublished, no permission). */
export const SCHEDULE_PAUSED_CODE = "SCD-4801";
/** Any other trigger failure (bad cron, run creation error, ...). */
export const SCHEDULE_TRIGGER_FAILED_CODE = "SCD-4803";

export type ScheduleTriggerResult =
  | { kind: "run"; runId: string }
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
    const principal: Principal = {
      type: "service",
      id: String(schedule.subject_id),
      name: String(schedule.name),
      role: "user",
      orgUnitId: schedule.org_unit_id ? String(schedule.org_unit_id) : null,
      dataScope: "org",
    };
    const runId = await createQueuedRun({
      agentId,
      versionId: agent.published_version_id,
      principal,
      input: parseJsonValue(schedule.input_json, { text: `Scheduled run: ${String(schedule.name)}` }),
      triggerType: "schedule",
      triggerRef: scheduleId,
    });
    const parsed = CronExpressionParser.parse(String(schedule.cron), {
      currentDate: now,
      tz: String(schedule.timezone ?? "Asia/Shanghai"),
    });
    const next = parsed.next().toDate();
    await repos.markScheduleRun(scheduleId, next, runId);
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
