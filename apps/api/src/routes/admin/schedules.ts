import { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Session } from "@forge/identity";
import { CronExpressionParser } from "cron-parser";
import { errors, ForgeError, type Principal } from "@forge/core";
import { createQueuedRun, resolveScheduleIdentity } from "@forge/runtime";
import { inOrgScope, maskArgsDeep, orgScopeIds } from "@forge/governance";
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

/** A schedule's service account must exist, be visible to the caller (own department or a sub-department unless dataScope all), be active and not platform_admin. */
async function requireUsableServiceAccount(principal: Principal, id: string) {
  const account = await repos.getServiceAccount(id);
  if (!account || !inOrgScope(await orgScopeIds(principal), account.org_unit_id)) throw errors.notFound("服务账号不存在");
  if (account.status !== "active") throw new ForgeError("SCD-4801", "服务账号已停用", 409);
  if (account.role === "platform_admin") throw new ForgeError("SCD-4804", "不能绑定 platform_admin 角色的服务账号", 400);
  return account;
}

/** Schedule data scope used by the list endpoint: dataScope all sees everything, otherwise the caller's department and its sub-departments (as runs). */
function scheduleVisible(scopeIds: string[] | null, schedule: Record<string, unknown>): boolean {
  return inOrgScope(scopeIds, schedule.org_unit_id);
}

/** Loads one schedule through the same data scope as the list; invisible and nonexistent both -> 404. */
async function loadVisibleScheduleOr404(principal: Principal, id: string): Promise<Record<string, unknown>> {
  const schedule = await repos.getSchedule(id);
  if (!schedule || !scheduleVisible(await orgScopeIds(principal), schedule)) throw errors.notFound("定时任务不存在");
  return schedule;
}

type ScheduleByIdContext = { request: FastifyRequest; session: Session; schedule: Record<string, unknown> };

/**
 * The only way to register a `/admin/api/schedules/:id...` route: checks the permission, then loads the schedule
 * through the list data scope (loadVisibleScheduleOr404) before the handler runs, so no :id route can skip the scope check.
 */
function scheduleByIdRoute(
  app: FastifyInstance,
  method: "GET" | "PATCH" | "PUT" | "DELETE" | "POST",
  suffix: "" | `/${string}`,
  permission: string,
  handler: (ctx: ScheduleByIdContext) => Promise<unknown>,
): void {
  app.route({
    method,
    url: `/admin/api/schedules/:id${suffix}`,
    handler: async (request) => {
      const session = await admin(request, permission);
      const schedule = await loadVisibleScheduleOr404(session.principal, param(request, "id"));
      return handler({ request, session, schedule });
    },
  });
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
    const scopeIds = await orgScopeIds(session.principal);
    const items = schedules
      .filter((schedule) => scheduleVisible(scopeIds, schedule))
      .map(presentScheduleExtras);
    return { items };
  });

  // Detail: same permission and data scope as the list (invisible and nonexistent -> identical 404), same item shape.
  scheduleByIdRoute(app, "GET", "", "schedule.view", async ({ schedule }) => {
    const row = await repos.getScheduleListRow(String(schedule.id));
    if (!row) throw errors.notFound("定时任务不存在");
    return presentScheduleExtras(row);
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

  scheduleByIdRoute(app, "PATCH", "", "schedule.manage", async ({ request, session, schedule }) => {
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
    await writeAudit(session, "schedule.update", "schedule", String(schedule.id), maskArgsDeep(fields));
    return { ok: true };
  });

  scheduleByIdRoute(app, "POST", "/enable", "schedule.manage", async ({ session, schedule }) => {
    if (schedule.service_account_id) {
      const account = await repos.getServiceAccount(String(schedule.service_account_id));
      if (!account || account.status !== "active") throw new ForgeError("SCD-4801", "服务账号已停用，不能启用定时任务", 409);
    }
    const next = CronExpressionParser.parse(String(schedule.cron), { currentDate: new Date(), tz: String(schedule.timezone) }).next().toDate();
    await repos.updateSchedule(String(schedule.id), { status: "active", next_run_at: next });
    await writeAudit(session, "schedule.enable", "schedule", String(schedule.id), { nextRunAt: next });
    return { ok: true };
  });

  scheduleByIdRoute(app, "POST", "/disable", "schedule.manage", async ({ session, schedule }) => {
    await repos.updateSchedule(String(schedule.id), { status: "disabled", next_run_at: null });
    await writeAudit(session, "schedule.disable", "schedule", String(schedule.id));
    return { ok: true };
  });

  scheduleByIdRoute(app, "POST", "/run", "schedule.run", async ({ session, schedule }) => {
    const agent = await repos.getAgent(String(schedule.agent_id));
    if (!agent?.published_version_id) throw errors.invalid("Agent 尚未发布");
    // Manual "run now" executes as the schedule's identity (bound service account, or the legacy service identity),
    // never as the clicking user; the clicking user only needs schedule.run (checked above).
    // Identity re-read live (S-45): unusable -> 409 SCD-4801 / SCD-4804, database error -> 503 SYS-9003.
    const principal = await resolveScheduleIdentity(schedule);
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
