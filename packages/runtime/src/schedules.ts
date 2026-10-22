import { CronExpressionParser } from "cron-parser";
import type { Principal } from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";
import { createQueuedRun } from "./loop.js";

export async function tickSchedules(now = new Date()): Promise<void> {
  const due = await repos.dueSchedules();
  for (const schedule of due) {
    try {
      const agentId = String(schedule.agent_id);
      const agent = await repos.getAgent(agentId);
      if (!agent || agent.status !== "active" || !agent.published_version_id) {
        await repos.updateSchedule(String(schedule.id), { status: "disabled", next_run_at: null });
        continue;
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
        triggerRef: String(schedule.id),
      });
      const parsed = CronExpressionParser.parse(String(schedule.cron), {
        currentDate: now,
        tz: String(schedule.timezone ?? "Asia/Shanghai"),
      });
      const next = parsed.next().toDate();
      await repos.markScheduleRun(String(schedule.id), next, runId);
    } catch {
      await repos.updateSchedule(String(schedule.id), {
        status: "disabled",
        next_run_at: null,
      });
    }
  }
}
