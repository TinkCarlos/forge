import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, hashApiKey, type Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, repos } from "@forge/store";

// Record every route as it is registered, so the route set can be compared with the baseline.
const registered = vi.hoisted(() => [] as { method: string; url: string }[]);
vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const factory = ((options?: unknown) => {
    const instance = (mod.default as unknown as (o?: unknown) => FastifyInstance)(options);
    instance.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) registered.push({ method: String(method), url: route.url });
    });
    return instance;
  }) as unknown as typeof mod.default;
  return { ...mod, default: factory };
});

const { buildApp } = await import("../apps/api/src/app.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const missingId = `it-missing-${suffix}`;

let app: FastifyInstance;
let adminCookie = "";
let adminCsrf = "";
let lowSession: Session;
let lowCookie = "";
let openAppId = "";
let openKey = "";

function code(res: LightMyRequestResponse): string | undefined {
  return (res.json() as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // Real local login for the platform admin (credentials come from .env via config, never logged).
  const login = await app.inject({
    method: "POST",
    url: "/auth/local/login",
    payload: { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((c) => c.name === "forge_session");
  expect(cookie).toBeDefined();
  adminCookie = `forge_session=${cookie!.value}`;
  adminCsrf = (login.json() as { csrfToken: string }).csrfToken;

  // Low-privilege principal: in-memory session only (role "user"), nothing written to the DB.
  const lowPrincipal: Principal = {
    type: "user",
    id: `it-low-${suffix}`,
    name: "IT Low Privilege",
    role: "user",
    orgUnitId: "01J00000000000000000000000",
    dataScope: "self",
  };
  lowSession = createSession(lowPrincipal);
  lowCookie = `forge_session=${sessionCookieValue(lowSession)}`;

  // Open-platform app whose key only has agents:read (cleaned up in afterAll; FK cascades the key).
  openAppId = await repos.createApiApp({ key: `it-routes-${suffix}`, name: "IT routes scope", scopes: ["agents:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({
    appId: openAppId,
    name: "it-routes",
    prefix: openKey.slice(0, 16),
    keyHash: hashApiKey(openKey, config.API_KEY_PEPPER),
    scopes: ["agents:read"],
  });
});

afterAll(async () => {
  if (lowSession) destroySession(lowSession.token);
  if (adminCookie) await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: adminCookie } });
  if (openAppId) {
    await execute("DELETE FROM api_keys WHERE app_id = ?", [openAppId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [openAppId]);
  }
  await app?.close();
});

describe("route set", () => {
  it("matches the 79-route baseline (excluding auto HEAD and the /assets/* static wildcard)", () => {
    const baseline = readFileSync(path.resolve(import.meta.dirname, "fixtures/routes-baseline.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    const actual = [
      ...new Set(
        registered
          .filter((r) => r.method !== "HEAD" && r.url !== "/assets/*")
          .map((r) => `${r.method} ${r.url}`),
      ),
    ].sort();
    expect(baseline).toHaveLength(79);
    expect(actual).toEqual(baseline);
    expect(app.hasRoute({ method: "GET", url: "/assets/*" })).toBe(true);
  });
});

describe("health", () => {
  it("GET /healthz -> 200", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /readyz -> 200 with database:true", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", database: true });
  });
});

describe("unauthenticated -> 401", () => {
  const cases: [string, string, Record<string, string>?][] = [
    ["GET", "/auth/session"],
    ["GET", "/admin/api/dashboard"],
    ["GET", "/admin/api/apps"],
    ["POST", "/admin/api/agents"],
    ["GET", "/open/v1/agents"],
    ["GET", "/open/v1/agents", { authorization: "Bearer fsk_not_a_real_key_000000" }],
    ["POST", "/open/v1/agents/any/runs"],
    ["GET", "/integration/v1/agents"],
    ["POST", "/integration/v1/runs"],
  ];
  for (const [method, url, headers] of cases) {
    it(`${method} ${url}${headers ? " (bad key)" : ""}`, async () => {
      const res = await app.inject({ method: method as "GET" | "POST", url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe("AUTH-1001");
    });
  }
});

describe("auth session", () => {
  it("POST /auth/local/login with wrong password -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/local/login",
      payload: { email: `nobody-${suffix}@forge.local`, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /auth/session with admin cookie -> 200 and same csrfToken", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ csrfToken: adminCsrf, permissions: ["*"] });
  });
});

describe("authorization -> 403", () => {
  it("role=user GET /admin/api/apps (needs apikey.view) -> 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/apps", headers: { cookie: lowCookie } });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
  });

  it("role=user GET /admin/api/audit (needs audit.view) -> 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/audit", headers: { cookie: lowCookie } });
    expect(res.statusCode).toBe(403);
  });

  it("role=user POST /admin/api/users with valid CSRF (needs user.manage) -> 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { cookie: lowCookie, "x-csrf-token": lowSession.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
  });

  it("role=user GET /admin/api/agents (has agent.view) -> 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/agents", headers: { cookie: lowCookie } });
    expect(res.statusCode).toBe(200);
  });

  it("open app with only agents:read: GET /open/v1/agents -> 200", async () => {
    const res = await app.inject({ method: "GET", url: "/open/v1/agents", headers: { authorization: `Bearer ${openKey}` } });
    expect(res.statusCode).toBe(200);
  });

  it("open app with only agents:read: POST /open/v1/runs/:id/cancel (needs runs:cancel) -> 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/open/v1/runs/${missingId}/cancel`,
      headers: { authorization: `Bearer ${openKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
  });

  it("open app with only agents:read: GET /open/v1/runs/:id (needs runs:read) -> 403", async () => {
    const res = await app.inject({ method: "GET", url: `/open/v1/runs/${missingId}`, headers: { authorization: `Bearer ${openKey}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe("CSRF on /admin/api writes", () => {
  it("missing x-csrf-token -> 403 POL-2001", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/agents", headers: { cookie: adminCookie }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
  });

  it("wrong x-csrf-token -> 403 POL-2001", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/apps/${missingId}`,
      headers: { cookie: adminCookie, "x-csrf-token": "wrong-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
  });

  it("valid x-csrf-token passes CSRF (reaches validation -> 400, nothing created)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/agents",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("CFG-8501");
  });
});

describe("parameter validation -> 400", () => {
  const write = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { cookie: adminCookie, "x-csrf-token": adminCsrf }, payload });

  it("POST /admin/api/agents with invalid key format", async () => {
    const res = await write("/admin/api/agents", { key: "Bad Key!" });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("CFG-8501");
  });

  it("POST /admin/api/apps without key", async () => {
    const res = await write("/admin/api/apps", { name: "no key" });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("CFG-8501");
  });

  it("POST /admin/api/users without email", async () => {
    const res = await write("/admin/api/users", {});
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("CFG-8501");
  });

  it("POST /auth/local/login without password", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/local/login", payload: { email: "x@forge.local" } });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("CFG-8501");
  });
});

describe("not found -> 404", () => {
  const cases: [string, string][] = [
    ["GET", `/admin/api/agents/${missingId}`],
    ["GET", `/admin/api/runs/${missingId}`],
    ["GET", `/admin/api/skills/${missingId}`],
    ["PATCH", `/admin/api/apps/${missingId}`],
  ];
  for (const [method, url] of cases) {
    it(`${method} ${url.replace(missingId, ":id")}`, async () => {
      const res = await app.inject({
        method: method as "GET" | "PATCH",
        url,
        headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
        payload: method === "PATCH" ? {} : undefined,
      });
      expect(res.statusCode).toBe(404);
      expect(code(res)).toBe("RUN-7001");
    });
  }
});
