import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, query } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// AF / S-60: percent-encoded /admin/api paths reach the same handlers, so they must get the same CSRF check.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let session: Session;
let cookieOnly: Record<string, string>;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const principal: Principal = { type: "user", id: ADMIN_ID, name: "admin", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" };
  session = await createSession(principal);
  cookieOnly = { cookie: `forge_session=${sessionCookieValue(session)}` };
});

afterAll(async () => {
  // Only matters if the fix regresses (a write got through): list this run's rows, then delete them by id.
  const leaked = await query<{ id: string }>("SELECT id FROM users WHERE email LIKE ?", [`it-csrf-%-${suffix}@forge.local`]);
  for (const { id } of leaked) await execute("DELETE FROM users WHERE id = ?", [id]);
  await destroySession(session.token);
  await app.close();
});

const emailFor = (tag: string) => `it-csrf-${tag}-${suffix}@forge.local`;

describe("S-60 CSRF on percent-encoded admin paths", () => {
  it("baseline: plain /admin/api without token -> 403 POL-2001", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/users", headers: cookieOnly, payload: { email: emailFor("plain"), role: "user" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("POL-2001");
  });

  for (const [tag, url] of [
    ["a", "/%61dmin/api/users"],
    ["d", "/a%64min/api/users"],
    ["p", "/admin/%61pi/users"],
    ["upper", "/%41dmin/api/users"],
  ] as const) {
    it(`POST ${url} without token -> 403 POL-2001, nothing written`, async () => {
      const res = await app.inject({ method: "POST", url, headers: cookieOnly, payload: { email: emailFor(tag), username: `it-csrf-${tag}-${suffix}`, role: "user" } });
      expect(res.statusCode).not.toBe(200);
      if (res.statusCode !== 404) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("POL-2001");
      }
      const rows = await query<{ id: string }>("SELECT id FROM users WHERE email = ?", [emailFor(tag)]);
      expect(rows).toHaveLength(0);
    });
  }

  it("PATCH /%61dmin/api/mcp/:id without token -> 403 before the handler (not 404)", async () => {
    const res = await app.inject({ method: "PATCH", url: "/%61dmin/api/mcp/01JNOTEXISTING0000000000000", headers: cookieOnly, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("POL-2001");
  });

  it("encoded path with the right token is not blocked by CSRF", async () => {
    const res = await app.inject({ method: "PATCH", url: "/%61dmin/api/mcp/01JNOTEXISTING0000000000000", headers: { ...cookieOnly, "x-csrf-token": session.csrfToken }, payload: { name: "x" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("S-60 encoded admin path that matches no route", () => {
  it("POST /%61dmin/api/no-such-route without token -> 403 POL-2001 (not let through as 404)", async () => {
    const res = await app.inject({ method: "POST", url: "/%61dmin/api/no-such-route", headers: cookieOnly, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("POL-2001");
  });
});
