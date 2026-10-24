import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { sessionCookieValue } from "@forge/identity";
import { triggerSchedule } from "@forge/runtime";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Cron macros (needs a *_test DB). Create / PATCH / enable store a macro as its 5-field expression (normalizeCron,
// @forge/core); @reboot and other macros -> 400. Legacy rows that already hold a macro (stored before validation, seeded
// here straight through the repository, which does not validate) can still be renamed, re-enabled and are fired by
// the scheduler.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const TZ = "Asia/Shanghai";
const MESSAGE = "只支持 5 段 cron 或 @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let accountId = "";
let seq = 0;

type Row = { status: string; next_run_at: Date | null; cron: string; name: string; last_error_code: string | null };
const row = async (id: string) => (await one<Row>("SELECT status, next_run_at, cron, name, last_error_code FROM schedules WHERE id = ?", [id]))!;
const err = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string; message?: string; details?: { field?: string } } }).error;
const nextMidnight = () => CronExpressionParser.parse("0 0 * * *", { currentDate: new Date(), tz: TZ }).next().toDate().getTime();

async function legacy(cron: string, status: "active" | "disabled"): Promise<string> {
  return repos.createSchedule({
    key: `it-scm-${suffix}-${seq++}`, name: "IT scm legacy", agentId, orgUnitId: ROOT, subjectType: "service", subjectId: accountId, serviceAccountId: accountId,
    cron, timezone: TZ, input: { text: "x" }, status, nextRunAt: status === "active" ? new Date(Date.now() - 1000) : null, createdBy: ADMIN_ID,
  });
}
const create = (cron: string) =>
  app.inject({ method: "POST", url: "/admin/api/schedules", headers, payload: { key: `it-scm-new-${suffix}-${seq++}`, agentId, serviceAccountId: accountId, cron } });
const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/admin/api/schedules/${id}`, headers, payload });
const enable = (id: string) => app.inject({ method: "POST", url: `/admin/api/schedules/${id}/enable`, headers });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT scm", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-scm-${suffix}`, name: "IT scm", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  accountId = await repos.createServiceAccount({ key: `it-scm-svc-${suffix}`, name: "IT scm svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
});

afterAll(async () => {
  await execute("UPDATE runs SET status = 'cancelled' WHERE trigger_type = 'schedule' AND status = 'queued' AND trigger_ref IN (SELECT id FROM schedules WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE trigger_type = 'schedule' AND status <> 'running' AND trigger_ref IN (SELECT id FROM schedules WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'schedule' AND resource_id IN (SELECT id FROM schedules WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM schedules WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("create / PATCH normalize cron macros", () => {
  const CASES: Array<[string, string]> = [
    ["@yearly", "0 0 1 1 *"], ["@annually", "0 0 1 1 *"], ["@monthly", "0 0 1 * *"], ["@weekly", "0 0 * * 0"],
    ["@daily", "0 0 * * *"], ["@midnight", "0 0 * * *"], ["@hourly", "0 * * * *"], ["@DAILY", "0 0 * * *"], [" @daily ", "0 0 * * *"],
  ];
  for (const [macro, expected] of CASES) {
    it(`POST cron=${JSON.stringify(macro)} -> 200, stored as ${expected}`, async () => {
      const res = await create(macro);
      expect(res.statusCode, res.body).toBe(200);
      expect((await row((res.json() as { id: string }).id)).cron).toBe(expected);
    });
  }

  it("POST a plain 5-field cron: only trimmed", async () => {
    const res = await create(" 0 9 * * MON ");
    expect(res.statusCode, res.body).toBe(200);
    expect((await row((res.json() as { id: string }).id)).cron).toBe("0 9 * * MON");
  });

  for (const bad of ["@reboot", " @REBOOT ", "@every 5m", "@dailyx"]) {
    it(`POST cron=${JSON.stringify(bad)} -> 400 with the accepted-forms message`, async () => {
      const res = await create(bad);
      expect(res.statusCode).toBe(400);
      expect(err(res)).toMatchObject({ code: "CFG-8501", message: MESSAGE, details: { field: "cron" } });
    });
  }

  it("PATCH cron=@weekly -> stored 0 0 * * 0; PATCH cron=@reboot -> 400, unchanged", async () => {
    const id = await legacy("0 9 * * *", "disabled");
    expect((await patch(id, { cron: "@weekly" })).statusCode).toBe(200);
    expect((await row(id)).cron).toBe("0 0 * * 0");
    const res = await patch(id, { cron: "@reboot" });
    expect(res.statusCode).toBe(400);
    expect(err(res)).toMatchObject({ code: "CFG-8501", message: MESSAGE, details: { field: "cron" } });
    expect((await row(id)).cron).toBe("0 0 * * 0");
  });

  it("legacy @daily row, PATCH name only -> 200, cron rewritten to 0 0 * * *", async () => {
    const id = await legacy("@daily", "disabled");
    const res = await patch(id, { name: "renamed" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(id)).toMatchObject({ name: "renamed", cron: "0 0 * * *" });
  });

  it("legacy @midnight row, PATCH with the old cron sent back (console edit form) -> 200, 0 0 * * *", async () => {
    const id = await legacy("@midnight", "disabled");
    const res = await patch(id, { name: "edited", cron: "@midnight", timezone: TZ });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(id)).toMatchObject({ name: "edited", cron: "0 0 * * *" });
  });

  it("legacy @reboot row, PATCH name only -> 200: the stored cron is not re-checked and stays as is", async () => {
    const id = await legacy("@reboot", "disabled");
    expect((await patch(id, { name: "renamed-reboot" })).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ name: "renamed-reboot", cron: "@reboot" });
  });
});

describe("/enable normalizes a legacy macro before the check and stores the 5-field form", () => {
  for (const [macro, expected] of [["@daily", "0 0 * * *"], ["@MIDNIGHT", "0 0 * * *"], [" @weekly ", "0 0 * * 0"]] as const) {
    it(`disabled legacy ${JSON.stringify(macro)} -> enable 200, active, cron ${expected}, next_run_at set`, async () => {
      const id = await legacy(macro, "disabled");
      const res = await enable(id);
      expect(res.statusCode, res.body).toBe(200);
      const after = await row(id);
      expect([after.status, after.cron]).toEqual(["active", expected]);
      expect(after.next_run_at).not.toBeNull();
      if (expected === "0 0 * * *") expect(new Date(after.next_run_at!).getTime()).toBe(nextMidnight());
    });
  }

  it("disabled legacy @reboot -> enable 400, still disabled, cron unchanged", async () => {
    const id = await legacy("@reboot", "disabled");
    const res = await enable(id);
    expect(res.statusCode).toBe(400);
    expect(err(res)).toMatchObject({ code: "CFG-8501", message: MESSAGE, details: { field: "cron" } });
    expect(await row(id)).toMatchObject({ status: "disabled", cron: "@reboot", next_run_at: null });
  });
});

describe("scheduler fires legacy macro rows (read-side normalizeCron)", () => {
  for (const macro of ["@daily", "@midnight", "@DAILY", " @Midnight "]) {
    it(`active legacy ${JSON.stringify(macro)} -> run, next_run_at = next local midnight`, async () => {
      const id = await legacy(macro, "active");
      const result = await triggerSchedule((await repos.getSchedule(id))!);
      expect(result.kind).toBe("run");
      const after = await row(id);
      expect([after.status, after.last_error_code]).toEqual(["active", null]);
      expect(new Date(after.next_run_at!).getTime()).toBe(nextMidnight());
    });
  }

  it("active legacy @reboot -> still fails (SCD-4803), no silent rewrite", async () => {
    const id = await legacy("@reboot", "active");
    expect((await triggerSchedule((await repos.getSchedule(id))!)).kind).toBe("failed");
    expect(await row(id)).toMatchObject({ status: "disabled", cron: "@reboot" });
  });
});
