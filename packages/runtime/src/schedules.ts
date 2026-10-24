import { CronExpressionParser } from "cron-parser";
import { errors, ForgeError, normalizeCron, type DataScope, type Principal, type Role } from "@forge/core";
import { parseJsonValue, repos, type ServiceAccountRow } from "@forge/store";
import { createQueuedRun } from "./loop.js";

/** Schedule paused because its identity/Agent is unusable (service account disabled, Agent disabled/unpublished, no permission). */
export const SCHEDULE_PAUSED_CODE = "SCD-4801";
/** Bound service account has role platform_admin, which service accounts may not hold. Pauses the schedule. */
export const SCHEDULE_FORBIDDEN_ROLE_CODE = "SCD-4804";
/** Any other trigger failure (bad cron, run creation error, ...). */
export const SCHEDULE_TRIGGER_FAILED_CODE = "SCD-4803";

export type ScheduleTriggerResult =
  | { kind: "run"; runId: string }
  | { kind: "skipped"; reason: "concurrency" }
  | { kind: "paused"; code: string }
  | { kind: "failed"; code: string };

/**
 * Identity a schedule runs as (pure; no I/O). Becomes the run's subject_type/subject_id, role, org and data scope.
 * - Bound schedule: the service account's own id/name/role/org/data scope (FR-TR-06; never the creator's identity).
 * - Legacy schedule (service_account_id NULL): type service, id = subject_id, role user, data scope org, org = schedule org.
 * Throws SCD-4801 if the schedule is bound but no account row is given, so a bound schedule can never fall back to the legacy identity.
 * Throws SCD-4804 if the account is platform_admin (service accounts may never run with platform_admin).
 */
export function buildScheduleIdentity(schedule: Record<string, unknown>, account: ServiceAccountRow | null): Principal {
  if (schedule.service_account_id) {
    if (!account || account.id !== String(schedule.service_account_id)) {
      throw new ForgeError(SCHEDULE_PAUSED_CODE, "定时任务绑定的服务账号不可用", 409);
    }
    if (account.role === "platform_admin") {
      throw new ForgeError(SCHEDULE_FORBIDDEN_ROLE_CODE, "服务账号不能以 platform_admin 身份运行定时任务", 409);
    }
    return {
      type: "service",
      id: account.id,
      name: account.name,
      role: account.role as Role,
      orgUnitId: account.org_unit_id,
      dataScope: account.data_scope as DataScope,
    };
  }
  return {
    type: "service",
    id: String(schedule.subject_id),
    name: String(schedule.name),
    role: "user",
    orgUnitId: schedule.org_unit_id ? String(schedule.org_unit_id) : null,
    dataScope: "org",
  };
}

/**
 * Live identity check for a schedule (S-45). Throws:
 * - SCD-4801 (409) when the identity is unusable: bound service account missing/disabled or any department on its chain
 *   inactive; legacy schedule whose user (subject_type 'user' -> subject_id, otherwise created_by) is missing, disabled,
 *   deleted or has an inactive department on its chain (same rule as session auth / loadActivePrincipal);
 * - SCD-4804 (409) for a platform_admin service account;
 * - SYS-9003 (503) when the database lookup itself fails (not "unusable").
 */
export async function resolveScheduleIdentity(schedule: Record<string, unknown>): Promise<Principal> {
  const lookup = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw errors.unavailable("身份校验暂时不可用，请稍后重试");
    }
  };
  if (schedule.service_account_id) {
    const account = await lookup(() => repos.getActiveServiceAccountById(String(schedule.service_account_id)));
    return buildScheduleIdentity(schedule, account);
  }
  const userId = String(schedule.subject_type ?? "") === "user" ? schedule.subject_id : schedule.created_by;
  const user = userId ? await lookup(() => repos.getActiveUserById(String(userId))) : null;
  if (!user) throw new ForgeError(SCHEDULE_PAUSED_CODE, "定时任务的运行身份不可用", 409);
  return buildScheduleIdentity(schedule, null);
}

/** Triggers one due schedule row. Failures are recorded on the schedule (failure_count, last_error_code) and stop it. */
export async function triggerSchedule(schedule: Record<string, unknown>, now = new Date()): Promise<ScheduleTriggerResult> {
  const scheduleId = String(schedule.id);
  try {
    // Parse cron + timezone first (I-SCH-17 / I-ERR-20): an invalid expression fails this schedule with SCD-4803 and
    // stops it before anything else is looked at, so no Run is ever created for it.
    let nextSlot: Date;
    try {
      // Legacy rows may hold a macro (@daily, @MIDNIGHT, ...): same normalizer as the API write side.
      const cron = normalizeCron(String(schedule.cron ?? ""));
      if (!cron) throw new Error("empty cron");
      nextSlot = CronExpressionParser.parse(cron, { currentDate: now, tz: String(schedule.timezone ?? "Asia/Shanghai") }).next().toDate();
    } catch {
      await repos.recordScheduleFailure(scheduleId, SCHEDULE_TRIGGER_FAILED_CODE);
      return { kind: "failed", code: SCHEDULE_TRIGGER_FAILED_CODE };
    }
    const nextRunAt = () => nextSlot;
    const agentId = String(schedule.agent_id);
    const agent = await repos.getAgent(agentId);
    if (!agent || agent.status !== "active" || !agent.published_version_id) {
      await repos.recordScheduleFailure(scheduleId, SCHEDULE_PAUSED_CODE);
      return { kind: "paused", code: SCHEDULE_PAUSED_CODE };
    }
    let principal: Principal;
    try {
      principal = await resolveScheduleIdentity(schedule);
    } catch (error) {
      // Identity refused (unusable account/user/department chain, or platform_admin account): pause.
      if (error instanceof ForgeError && (error.code === SCHEDULE_PAUSED_CODE || error.code === SCHEDULE_FORBIDDEN_ROLE_CODE)) {
        await repos.recordScheduleFailure(scheduleId, error.code);
        return { kind: "paused", code: error.code };
      }
      // Database error during the identity lookup: fail only this trigger, keep the schedule active.
      if (error instanceof ForgeError && error.code === "SYS-9003") {
        try {
          await repos.recordScheduleTriggerError(scheduleId, SCHEDULE_TRIGGER_FAILED_CODE, nextRunAt());
        } catch {
          // database still down: nothing recorded; the row stays due and is retried on the next tick
        }
        return { kind: "failed", code: SCHEDULE_TRIGGER_FAILED_CODE };
      }
      throw error;
    }
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

/**
 * One scheduler tick. Rejects when the database is unreachable (dueSchedules, or recordScheduleFailure in
 * triggerSchedule's catch). Callers must run it through guardTick (worker.ts), which catches, logs and backs off
 * (K-20 / OPS-010); it is never invoked as a bare `void tickSchedules()`.
 */
export async function tickSchedules(now = new Date()): Promise<void> {
  const due = await repos.dueSchedules();
  for (const schedule of due) {
    await triggerSchedule(schedule, now);
  }
}
