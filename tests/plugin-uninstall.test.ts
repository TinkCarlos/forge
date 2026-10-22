import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// #68 / I-PLG-04 (this round): uninstalling a plugin that does not exist is 404 (no audit, nothing changed);
// org_admin still has no plugin.uninstall -> 403. Department scoping of uninstall waits for the owner-department column.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let paHeaders: Record<string, string> = {};
let orgAdminHeaders: Record<string, string> = {};
let pluginId = "";

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string } }).error;
const uninstall = (id: string, headers: Record<string, string>) => app.inject({ method: "POST", url: `/admin/api/plugins/${id}/uninstall`, headers, payload: {} });
const audits = async (id: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'plugin.uninstall' AND resource_id = ?", [id]))[0]!.n;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  paHeaders = sessionHeaders(pa, sessionCookieValue(pa));
  const oa = await realSession({ role: "org_admin", orgUnitId: ROOT, dataScope: "org" });
  orgAdminHeaders = sessionHeaders(oa, sessionCookieValue(oa));
  pluginId = await repos.createPlugin({ key: `it-plg-${suffix}`, version: "1.0.0", type: "mixed", name: "IT plugin", manifest: {}, resources: {}, createdBy: ADMIN_ID });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE action = 'plugin.uninstall' AND resource_id IN (?, ?)", [pluginId, `pkg_missing_${suffix}`]);
  await execute("DELETE FROM plugins WHERE id = ?", [pluginId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("plugin uninstall (#68, I-PLG-04)", () => {
  it("nonexistent plugin -> 404, no audit", async () => {
    const missing = `pkg_missing_${suffix}`;
    const res = await uninstall(missing, paHeaders);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).message).toBe("插件不存在");
    expect(await audits(missing)).toBe(0);
  });

  it("org_admin -> 403 (no plugin.uninstall), plugin unchanged, no audit", async () => {
    const res = await uninstall(pluginId, orgAdminHeaders);
    expect(res.statusCode).toBe(403);
    expect((await query<{ status: string }>("SELECT status FROM plugins WHERE id = ?", [pluginId]))[0]!.status).toBe("active");
    expect(await audits(pluginId)).toBe(0);
  });

  it("org_admin on a nonexistent plugin -> still 403 (permission first)", async () => {
    expect((await uninstall(`pkg_missing_${suffix}`, orgAdminHeaders)).statusCode).toBe(403);
  });

  it("platform_admin uninstalls an existing plugin -> 200, status uninstalled, audited", async () => {
    const res = await uninstall(pluginId, paHeaders);
    expect(res.statusCode).toBe(200);
    expect((await query<{ status: string }>("SELECT status FROM plugins WHERE id = ?", [pluginId]))[0]!.status).toBe("uninstalled");
    expect(await audits(pluginId)).toBe(1);
    // already uninstalled but still exists -> 200 (idempotent), not 404
    expect((await uninstall(pluginId, paHeaders)).statusCode).toBe(200);
  });
});
