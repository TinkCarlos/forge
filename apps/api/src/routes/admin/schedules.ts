import { type FastifyInstance } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { errors, ForgeError, type Principal } from "@forge/core";
import { buildScheduleIdentity, createQueuedRun } from "@forge/runtime";
import { parseJsonValue, repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  admin,
  writeAudit,
  agentAccessible,
  requireBodyString,
} from "../../plugins/http-helpers.js";

/** A schedule's service account must exist, be visible to the caller (same org unless dataScope all), be active and not platform_admin. */
async function requireUsableServiceAccount(principal: Principal, id: string) {
  const account = await repos.getServiceAccount(id);
  if (!account || (principal.dataScope !== "all" && account.org_unit_id !== principal.orgUnitId)) throw errors.notFound("服务账号不存在");
  if (account.status !== "active") throw new ForgeError("SCD-4801", "服务账号已停用", 409);
  if (account.role === "platform_admin") throw errors.invalid("不能绑定 platform_admin 角色的服务账号");
  return account;
}

/** Schedule data scope used by the list endpoint: dataScope all sees everything, otherwise only the caller's org. */
function scheduleVisible(principal: Principal, schedule: Record<string, unknown>): boolean {
  if (principal.dataScope === "all") return true;
  return schedule.org_unit_id === principal.orgUnitId;
}

/** Loads one schedule through the same data scope as the list; invisible and nonexistent both -> 404. */
async function loadVisibleSchedule(principal: Principal, id: string): Promise<Record<string, unknown>> {
  const schedule = await repos.getSchedule(id);
  if (!schedule || !scheduleVisible(principal, schedule)) throw errors.notFound("定时任务不存在");
  return schedule;
}

/** Additive camelCase fields on top of the raw schedule row (raw snake_case keys stay for compatibility). */
function presentScheduleExtras(schedule: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schedule,
    serviceAccountId: schedule.service_account_id ?? null,
    failureCount: Number(schedule.failure_count ?? 0),
    lastErrorCode: schedule.last_error_code ?? null,
  };
}

export default async function adminScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/schedules", async (request) => {
    const session = await admin(request, "schedule.view");
    const schedules = await repos.listSchedules();
    const items = schedules
      .filter((schedule) => scheduleVisible(session.principal, schedule))
      .map(presentScheduleExtras);
    return { items };
  });

  app.post("/admin/api/schedules", async (request) => {
    const session = await admin(request, "schedule.manage");
    const body = bodyOf(request);
    const agent = await repos.getAgent(requireBodyString(body, "agentId"));
    if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
    if (!agent.published_version_id) throw errors.invalid("Agent 尚未发布");
    // FR-TR-06 / permissions.md §3.4: new schedules run as a service account, never as the creator.
    const account = await requireUsableServiceAccount(session.principal, requireBodyString(body, "serviceAccountId"));
    const cron = requireBodyString(body, "cron");
    const timezone = stringBody(body, "timezone", "Asia/Shanghai");
    let nextRunAt: Date | null = null;
    try {
      nextRunAt = CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next().toDate();
    } catch {
      throw errors.invalid("Cron 表达式无效");
    }
    const id = await repos.createSchedule({
      key: stringBody(body, "key", `schedule-${Date.now()}`),
      name: stringBody(body, "name", "Scheduled Agent"),
      agentId: agent.id,
      orgUnitId: session.principal.orgUnitId,
      subjectType: "service",
      subjectId: account.id,
      serviceAccountId: account.id,
      cron,
      timezone,
      input: jsonBody(body, "input", { text: "" }),
      status: body.enabled === true ? "active" : "disabled",
      nextRunAt: body.enabled === true ? nextRunAt : null,
      createdBy: session.principal.id,
    });
    await writeAudit(session, "schedule.create", "schedule", id, { agentId: agent.id, serviceAccountId: account.id, cron });
    return { id };
  });

  app.patch("/admin/api/schedules/:id", async (request) => {
    const session = await admin(request, "schedule.manage");
    const schedule = await loadVisibleSchedule(session.principal, param(request, "id"));
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.cron !== undefined) fields.cron = stringBody(body, "cron");
    if (body.timezone !== undefined) fields.timezone = stringBody(body, "timezone");
    if (body.input !== undefined) fields.input_json = jsonBody(body, "input", {});
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    if (body.serviceAccountId !== undefined) fields.service_account_id = (await requireUsableServiceAccount(session.principal, requireBodyString(body, "serviceAccountId"))).id;
    if (body.cron && body.status === "active") {
      fields.next_run_at = CronExpressionParser.parse(String(fields.cron), { currentDate: new Date(), tz: String(fields.timezone ?? schedule.timezone) }).next().toDate();
    }
    await repos.updateSchedule(schedule.id as string, fields);
    await writeAudit(session, "schedule.update", "schedule", String(schedule.id), fields);
    return { ok: true };
  });

  app.post("/admin/api/schedules/:id/enable", async (request) => {
    const session = await admin(request, "schedule.manage");
    const schedule = await repos.getSchedule(param(request, "id"));
    if (!schedule) throw errors.notFound("定时任务不存在");
    if (schedule.service_account_id) {
      const account = await repos.getServiceAccount(String(schedule.service_account_id));
      if (!account || account.status !== "active") throw new ForgeError("SCD-4801", "服务账号已停用，不能启用定时任务", 409);
    }
    const next = CronExpressionParser.parse(String(schedule.cron), { currentDate: new Date(), tz: String(schedule.timezone) }).next().toDate();
    await repos.updateSchedule(String(schedule.id), { status: "active", next_run_at: next });
    return { ok: true };
  });

  app.post("/admin/api/schedules/:id/disable", async (request) => {
    const session = await admin(request, "schedule.manage");
    const schedule = await repos.getSchedule(param(request, "id"));
    if (!schedule) throw errors.notFound("定时任务不存在");
    await repos.updateSchedule(String(schedule.id), { status: "disabled", next_run_at: null });
    return { ok: true };
  });

  app.post("/admin/api/schedules/:id/run", async (request) => {
    const session = await admin(request, "schedule.run");
    const schedule = await loadVisibleSchedule(session.principal, param(request, "id"));
    const agent = await repos.getAgent(String(schedule.agent_id));
    if (!agent?.published_version_id) throw errors.invalid("Agent 尚未发布");
    // Manual "run now" executes as the schedule's identity (bound service account, or the legacy service identity),
    // never as the clicking user; the clicking user only needs schedule.run (checked above).
    let account = null;
    if (schedule.service_account_id) {
      account = await repos.getServiceAccount(String(schedule.service_account_id));
      if (!account || account.status !== "active") throw new ForgeError("SCD-4801", "服务账号已停用，不能运行定时任务", 409);
    }
    const principal = buildScheduleIdentity(schedule, account);
    if (String(schedule.concurrency_policy ?? "skip") === "skip" && (await repos.hasInFlightScheduleRun(String(schedule.id)))) {
      throw new ForgeError("SCD-4802", "该定时任务已有运行中的 Run（并发策略 skip）", 409);
    }
    const runId = await createQueuedRun({
      agentId: agent.id,
      versionId: agent.published_version_id,
      principal,
      input: parseJsonValue(schedule.input_json, { text: "" }),
      triggerType: "schedule",
      triggerRef: String(schedule.id),
    });
    await writeAudit(session, "schedule.run", "schedule", String(schedule.id), { runId, runAs: { type: principal.type, id: principal.id } });
    return { runId, trigger: "schedule" };
  });
}
