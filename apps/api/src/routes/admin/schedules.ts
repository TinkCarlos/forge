import { type FastifyInstance } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { errors } from "@forge/core";
import { createQueuedRun } from "@forge/runtime";
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
      .filter((schedule) => {
        if (session.principal.dataScope === "all") return true;
        return schedule.org_unit_id === session.principal.orgUnitId;
      })
      .map(presentScheduleExtras);
    return { items };
  });

  app.post("/admin/api/schedules", async (request) => {
    const session = await admin(request, "schedule.manage");
    const body = bodyOf(request);
    const agent = await repos.getAgent(requireBodyString(body, "agentId"));
    if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
    if (!agent.published_version_id) throw errors.invalid("Agent 尚未发布");
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
      subjectType: "user",
      subjectId: session.principal.id,
      cron,
      timezone,
      input: jsonBody(body, "input", { text: "" }),
      status: body.enabled === true ? "active" : "disabled",
      nextRunAt: body.enabled === true ? nextRunAt : null,
      createdBy: session.principal.id,
    });
    await writeAudit(session, "schedule.create", "schedule", id, { agentId: agent.id, cron });
    return { id };
  });

  app.patch("/admin/api/schedules/:id", async (request) => {
    const session = await admin(request, "schedule.manage");
    const schedule = await repos.getSchedule(param(request, "id"));
    if (!schedule) throw errors.notFound("定时任务不存在");
    if (session.principal.dataScope !== "all" && schedule.org_unit_id !== session.principal.orgUnitId) throw errors.notFound("定时任务不存在");
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.cron !== undefined) fields.cron = stringBody(body, "cron");
    if (body.timezone !== undefined) fields.timezone = stringBody(body, "timezone");
    if (body.input !== undefined) fields.input_json = jsonBody(body, "input", {});
    if (body.status !== undefined) fields.status = stringBody(body, "status");
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
    const schedule = await repos.getSchedule(param(request, "id"));
    if (!schedule) throw errors.notFound("定时任务不存在");
    const agent = await repos.getAgent(String(schedule.agent_id));
    if (!agent?.published_version_id) throw errors.invalid("Agent 尚未发布");
    const runId = await createQueuedRun({
      agentId: agent.id,
      versionId: agent.published_version_id,
      principal: session.principal,
      input: parseJsonValue(schedule.input_json, { text: "" }),
      triggerType: "schedule",
      triggerRef: String(schedule.id),
    });
    await writeAudit(session, "schedule.run", "schedule", String(schedule.id), { runId });
    return { runId };
  });
}
