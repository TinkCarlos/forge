import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Acceptance P0-02 / K-05 (I-SCOPE-04, I-SCOPE-06, S-22) - needs a *_test DB.
// Writes outside the caller's data scope -> 403 POL-2001 and no change in api_apps / api_keys / webhook_deliveries /
// audit_logs; inside the scope (own department and its subtree) still 200; dataScope=all writes anywhere.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (t: string): string => `${t}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const D = id26("ICWD");
const DC = id26("ICWC");
const S = id26("ICWS");
let app: FastifyInstance;
const apps: Record<string, string> = {};
const deliveries: Record<string, string> = {};
let oaHeaders: Record<string, string>;
let paHeaders: Record<string, string>;

async function headersFor(principal: Pick<Principal, "role" | "orgUnitId" | "dataScope">) {
  const session = await realSession({ name: "IT cross-org write", ...principal });
  return sessionHeaders(session, sessionCookieValue(session));
}
async function snapshot(appId: string) {
  const [row] = await query<Record<string, unknown>>("SELECT name, status, updated_at FROM api_apps WHERE id = ?", [appId]);
  const [keys] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE app_id = ?", [appId]);
  const dels = await query<Record<string, unknown>>("SELECT id, status, attempts, next_attempt_at, error_message FROM webhook_deliveries WHERE app_id = ? ORDER BY id", [appId]);
  const [audit] = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE outcome = 'success' AND (resource_id = ? OR resource_id IN (SELECT id FROM webhook_deliveries WHERE app_id = ?) OR JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.appId')) = ?)",
    [appId, appId, appId],
  );
  return { row, keys: Number(keys!.n), dels, audit: Number(audit!.n) };
}
async function newApp(name: string, org: string | null): Promise<string> {
  const id = await repos.createApiApp({ key: `it-cw-${name}-${suffix}`, name: `IT cw ${name}`, ownerOrgUnitId: org, scopes: [], createdBy: ADMIN_ID });
  const delivery = (await repos.enqueueWebhook({ appId: id, eventId: `ev-cw-${name}-${suffix}`, eventType: "run.completed", payload: {} }))!;
  await execute("UPDATE webhook_deliveries SET status = 'failed', attempts = 3, error_message = 'x' WHERE id = ?", [delivery]);
  deliveries[name] = delivery;
  return id;
}
const writes = {
  patch: async (id: string, h: Record<string, string>) => app.inject({ method: "PATCH", url: `/admin/api/apps/${id}`, headers: await configurationHeaders(`/admin/api/apps/${id}`, h), payload: { name: "renamed" } }),
  issueKey: async (id: string, h: Record<string, string>) => app.inject({ method: "POST", url: `/admin/api/apps/${id}/keys`, headers: await configurationHeaders(`/admin/api/apps/${id}/keys`, h), payload: { name: "k" } }),
  replay: (_id: string, h: Record<string, string>, name: string) => app.inject({ method: "POST", url: `/admin/api/webhook-deliveries/${deliveries[name]}/replay`, headers: h }),
};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [D, ROOT, `it-cw-d-${suffix}`, "IT cw D", `/it-cw-d-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [DC, D, `it-cw-dc-${suffix}`, "IT cw DC", `/it-cw-d-${suffix}/it-cw-dc-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [S, ROOT, `it-cw-s-${suffix}`, "IT cw S", `/it-cw-s-${suffix}/`]);
  apps.root = await newApp("root", ROOT);
  apps.sibling = await newApp("sibling", S);
  apps.global = await newApp("global", null);
  apps.own = await newApp("own", D);
  apps.child = await newApp("child", DC);
  oaHeaders = await headersFor({ role: "org_admin", orgUnitId: D, dataScope: "org" });
  paHeaders = await headersFor({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
});

afterAll(async () => {
  const ids = Object.values(apps);
  if (ids.length) {
    await execute(`DELETE FROM audit_logs WHERE resource_id IN (SELECT id FROM api_keys WHERE app_id IN (${ids.map(() => "?").join(",")}))`, ids);
    await execute(`DELETE FROM audit_logs WHERE resource_id IN (${ids.map(() => "?").join(",")})`, ids);
    await execute(`DELETE FROM audit_logs WHERE resource_id IN (SELECT id FROM webhook_deliveries WHERE app_id IN (${ids.map(() => "?").join(",")}))`, ids);
    await execute(`DELETE FROM webhook_deliveries WHERE app_id IN (${ids.map(() => "?").join(",")})`, ids);
    await execute(`DELETE FROM api_keys WHERE app_id IN (${ids.map(() => "?").join(",")})`, ids);
    await execute(`DELETE FROM api_apps WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  await cleanupRealSessions();
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [DC, D, S]);
  await app?.close();
});

describe("K-05: org admin of a non-root department writing outside its data scope", () => {
  for (const target of ["root", "sibling", "global"] as const) {
    for (const op of ["patch", "issueKey", "replay"] as const) {
      it(`${op} on the ${target} app -> 403 POL-2001, nothing changes`, async () => {
        const before = await snapshot(apps[target]!);
        const res = await writes[op](apps[target]!, oaHeaders, target);
        expect(res.statusCode).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe("POL-2001");
        expect(await snapshot(apps[target]!)).toEqual(before);
      });
    }
  }
});

describe("K-05: writes inside the data scope still work", () => {
  for (const target of ["own", "child"] as const) {
    it(`patch + issue key on the ${target} app -> 200`, async () => {
      expect((await writes.patch(apps[target]!, oaHeaders)).statusCode).toBe(200);
      const key = await writes.issueKey(apps[target]!, oaHeaders);
      expect(key.statusCode).toBe(200);
      const after = await snapshot(apps[target]!);
      expect(after.row?.name).toBe("renamed");
      expect(after.keys).toBe(1);
    });
  }
  it("replay inside the scope passes the scope check (delivery reset away from failed/3)", async () => {
    const res = await writes.replay(apps.own!, oaHeaders, "own");
    expect(res.statusCode).toBe(200);
    const [row] = await query<{ attempts: number; error_message: string | null }>("SELECT attempts, error_message FROM webhook_deliveries WHERE id = ?", [deliveries.own]);
    expect(row!.error_message === "x" && Number(row!.attempts) === 3).toBe(false);
  });
  it("dataScope=all (platform admin) writes the root app", async () => {
    expect((await writes.patch(apps.root!, paHeaders)).statusCode).toBe(200);
    expect((await writes.issueKey(apps.root!, paHeaders)).statusCode).toBe(200);
  });
  it("reads stay global (apps list shows the root app to the department admin)", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/apps", headers: oaHeaders });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === apps.root)).toBe(true);
  });
});
