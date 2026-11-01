import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// User status (create + PATCH) and Skill status (K-12 / I-SKL-07) only accept the values the code uses:
// active / disabled. Anything else (incl. > 16 chars, wrong case, non-string) -> 400 CFG-8501, nothing written.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let userId = "";
let skillId = "";
const createdUsers: string[] = [];

const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code: string } }).error?.code;
const BAD: unknown[] = ["foo", "deleted", "ACTIVE", "", "a".repeat(17), 1, null];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  userId = await repos.createUser({ email: `it-st-${suffix}@forge.local`, username: `it-st-${suffix}`, displayName: "IT st", role: "user", dataScope: "self", orgUnitId: ROOT });
  createdUsers.push(userId);
  skillId = await repos.createSkill({ key: `it-st-skill-${suffix}`, name: "IT st", description: "", content: "# x", publish: true, createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const id of createdUsers) {
    await execute("DELETE FROM audit_logs WHERE resource_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  await execute("DELETE FROM users WHERE email LIKE ?", [`it-st-new-%-${suffix}@forge.local`]);
  await execute("DELETE FROM audit_logs WHERE resource_id = ?", [skillId]);
  await execute("DELETE FROM skill_versions WHERE skill_id = ?", [skillId]);
  await execute("DELETE FROM skills WHERE id = ?", [skillId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("user status whitelist", () => {
  for (const status of BAD) {
    it(`PATCH status=${JSON.stringify(status)} -> 400 CFG-8501, unchanged`, async () => {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/users/${userId}`, headers: await configurationHeaders(`/admin/api/users/${userId}`, headers), payload: { status } });
      expect(res.statusCode, res.body).toBe(400);
      expect(code(res)).toBe("CFG-8501");
      expect((await repos.getUserById(userId))!.status).toBe("active");
    });
    it(`POST status=${JSON.stringify(status)} -> 400 CFG-8501, not created`, async () => {
      const email = `it-st-new-${randomBytes(3).toString("hex")}-${suffix}@forge.local`;
      const res = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload: { email, role: "user", status } });
      expect(res.statusCode, res.body).toBe(400);
      expect(code(res)).toBe("CFG-8501");
      expect(await repos.getUserByEmail(email)).toBeNull();
    });
  }
  it("PATCH disabled then active -> 200", async () => {
    for (const status of ["disabled", "active"]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/users/${userId}`, headers: await configurationHeaders(`/admin/api/users/${userId}`, headers), payload: { status } });
      expect(res.statusCode, res.body).toBe(200);
      expect((await repos.getUserById(userId))!.status).toBe(status);
    }
  });
  it("POST with status disabled -> 200, stored disabled; without status -> active", async () => {
    const email = `it-st-new-dis-${suffix}@forge.local`;
    const res = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload: { email, role: "user", status: "disabled" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await repos.getUserById((res.json() as { id: string }).id))!.status).toBe("disabled");
    const email2 = `it-st-new-def-${suffix}@forge.local`;
    const res2 = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload: { email: email2, role: "user" } });
    expect((await repos.getUserById((res2.json() as { id: string }).id))!.status).toBe("active");
  });
});

describe("skill status whitelist (K-12, I-SKL-07)", () => {
  const skillStatus = async () => String((await repos.getSkill(skillId))!.status);
  for (const status of BAD) {
    it(`PATCH status=${JSON.stringify(status)} -> 400 CFG-8501 (not silently disabled, not 500)`, async () => {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/skills/${skillId}`, headers: await configurationHeaders(`/admin/api/skills/${skillId}`, headers), payload: { status } });
      expect(res.statusCode, res.body).toBe(400);
      expect(code(res)).toBe("CFG-8501");
      expect(await skillStatus()).toBe("active");
    });
  }
  it("valid values -> 200", async () => {
    for (const status of ["disabled", "active"]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/skills/${skillId}`, headers: await configurationHeaders(`/admin/api/skills/${skillId}`, headers), payload: { status } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await skillStatus()).toBe(status);
    }
  });
});
