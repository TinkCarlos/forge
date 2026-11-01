import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// I-USR-01: GET /admin/api/users returns a whitelist of fields (no spread of the row). Field names stay the
// snake_case ones the legacy console (apps/console/public/app.js) and smoke.ts read. idp_subject and
// is_emergency_admin are only present for platform_admin.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let paHeaders: Record<string, string> = {};
let oaHeaders: Record<string, string> = {};
let userId = "";

const BASE = ["roles","additional_role_ids","effective_permissions","has_local_password", "can_manage", "revision", "id", "username", "email", "display_name", "role", "data_scope", "org_unit_id", "status", "created_at", "updated_at"].sort();
const PA_ONLY = ["idp_issuer", "idp_subject", "is_emergency_admin"];

async function list(headers: Record<string, string>) {
  const res = await app.inject({ method: "GET", url: "/admin/api/users", headers });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Array<Record<string, unknown>> }).items;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  paHeaders = sessionHeaders(pa, sessionCookieValue(pa));
  const oa = await realSession({ role: "org_admin", orgUnitId: ROOT, dataScope: "org" });
  oaHeaders = sessionHeaders(oa, sessionCookieValue(oa));
  userId = await repos.createUser({
    email: `it-up-${suffix}@forge.local`, username: `it-up-${suffix}`, displayName: "IT up", role: "user", dataScope: "self",
    orgUnitId: ROOT, passwordHash: hashPassword("password12345"), idpSubject: `it-up-sub-${suffix}`, emergency: true,
  });
});

afterAll(async () => {
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("GET /admin/api/users presenter (I-USR-01)", () => {
  it("platform_admin: whitelist + idp_subject / is_emergency_admin, never password_hash", async () => {
    const item = (await list(paHeaders)).find((u) => u.id === userId)!;
    expect(Object.keys(item).sort()).toEqual([...BASE, ...PA_ONLY].sort());
    expect(item).toMatchObject({ email: `it-up-${suffix}@forge.local`, display_name: "IT up", role: "user", data_scope: "self", status: "active", idp_subject: `it-up-sub-${suffix}`, is_emergency_admin: true });
  });

  it("org_admin: same whitelist without idp_subject / is_emergency_admin", async () => {
    const items = await list(oaHeaders);
    const item = items.find((u) => u.id === userId)!;
    expect(Object.keys(item).sort()).toEqual(BASE);
    const raw = JSON.stringify(items);
    for (const key of ["password_hash", ...PA_ONLY]) expect(raw).not.toContain(`"${key}"`);
    expect(raw).not.toContain(`it-up-sub-${suffix}`);
  });
});
