import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";

// P1 (architect, final ruling on base 7479400): every write route (POST/PUT/PATCH/DELETE) declares a body schema;
// admin / console routes are closed (additionalProperties: false) and an undeclared field is REJECTED with 400
// CFG-8501 (details.field = that field), not stripped. Fastify's default ajv has removeAdditional: true (would strip
// silently), so AJV_CUSTOM_OPTIONS sets removeAdditional: false globally. External routes (Connector
// /integration/v1/*, open platform /open/*) declare fields and types but stay open: EXTERNAL_OPEN below, one reason each.
// Action routes without a body use an empty schema: no body and {} pass, any field is 400 (open on external routes).
// Scope: top-level objects. Nested user JSON (plugin manifest / resources, spec, input, headers) stays open.
// Querystring (`limit`) schemas stay open (list routes take other filters); there are no params schemas.
// Pure (no DB / .env): @forge/core is stubbed because it parses the config on import. Real routes: route-schema-coverage.
const { ForgeError } = vi.hoisted(() => ({
  ForgeError: class ForgeError extends Error {
    constructor(public readonly code: string, message: string, public readonly httpStatus = 400, public readonly details?: unknown) {
      super(message);
    }
  },
}));
vi.mock("@forge/core", async () => ({
  ...(await import("../packages/core/src/cron.js")),
  ForgeError,
  errors: { invalid: (m: string, details?: unknown) => new ForgeError("CFG-8501", m, 400, details) },
}));
import { AJV_CUSTOM_OPTIONS, ROUTE_SCHEMAS, assertValidInput } from "../apps/api/src/plugins/input-schema.js";

const ROOT = new URL("../apps/api/src/routes/", import.meta.url).pathname;
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"|\bscheduleByIdRoute\(app,\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]*)"/g;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });

type BodySchema = { type?: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown };
const schemas = ROUTE_SCHEMAS as unknown as Record<string, { body?: BodySchema }>;

const EXTERNAL_OPEN: Record<string, string> = {
  "POST /integration/v1/runs": "Connector entry called by the external agent platform; extra fields must not break it",
  "POST /integration/v1/runs/:id/cancel": "Connector action route (no body read); external caller, kept open",
  "POST /open/v1/agents/:key/runs": "open platform API for third-party apps (API key); forward-compatible clients",
  "POST /open/v1/agents/:key/invoke": "open platform API for third-party apps (same body as /runs)",
  "POST /open/v1/runs/:id/cancel": "open platform action route (no body read); third-party callers, kept open",
};

/** Every write route (POST/PUT/PATCH/DELETE) and the ROUTE_SCHEMAS entry it registers (null when none). */
const writeRoutes = files(ROOT).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const matches = [...src.matchAll(REGISTRATION)];
  return matches.flatMap((m, i) => {
    const segment = src.slice(m.index, matches[i + 1]?.index ?? src.length);
    const method = (m[1] ?? m[3] ?? "").toUpperCase();
    const url = m[2] ?? `/admin/api/schedules/:id${m[4] ?? ""}`;
    const schema = /schema: ROUTE_SCHEMAS\.(\w+)/.exec(segment)?.[1] ?? null;
    return method !== "GET" ? [{ route: `${method} ${url}`, schema }] : [];
  });
});
const closed = (r: { schema: string | null }) => schemas[r.schema ?? ""]?.body?.additionalProperties === false;

async function bare(schema: object) {
  const app = Fastify({ ajv: { customOptions: AJV_CUSTOM_OPTIONS } });
  app.setErrorHandler((e: Error & { code?: string; httpStatus?: number; details?: unknown }, _req, reply) =>
    reply.status(e.httpStatus ?? 500).send({ code: e.code, message: e.message, details: e.details }));
  app.post("/x", { schema: schema as never, attachValidation: true }, async (request) => {
    assertValidInput(request);
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe("P1: write body schemas are closed (admin / console) and undeclared fields are rejected", () => {
  it("the app's ajv options turn stripping off globally (Fastify defaults to removeAdditional: true)", () => {
    expect(AJV_CUSTOM_OPTIONS).toMatchObject({ coerceTypes: false, removeAdditional: false });
  });

  it("the scan sees every write route (guards the regex; update the counts with a new route)", () => {
    expect(writeRoutes.length).toBe(42);
    expect(writeRoutes.map((r) => r.route)).toEqual(expect.arrayContaining(["PATCH /admin/api/agents/:id", "PATCH /admin/api/schedules/:id", "POST /admin/api/schedules/:id/run", "POST /auth/logout", ...Object.keys(EXTERNAL_OPEN)]));
  });

  it("every write route registers a body schema", () => {
    expect(writeRoutes.filter((r) => !schemas[r.schema ?? ""]?.body).map((r) => r.route)).toEqual([]);
  });

  it("every admin / console write route is closed; only the listed external routes are open, each with a reason", () => {
    expect(writeRoutes.filter((r) => !EXTERNAL_OPEN[r.route] && !closed(r)).map((r) => `${r.route} (${r.schema})`)).toEqual([]);
    expect(writeRoutes.filter((r) => EXTERNAL_OPEN[r.route]).map((r) => [r.route, closed(r)])).toEqual(Object.keys(EXTERNAL_OPEN).map((k) => [k, false]));
    expect(Object.keys(EXTERNAL_OPEN).every((k) => /^POST \/(integration\/v1|open)\//.test(k))).toBe(true);
  });

  it("an undeclared field on a closed schema (agentPatch) -> 400 CFG-8501 field=<name>; apiEnabled 'yes' / 'false' -> 400", async () => {
    const app = await bare(ROUTE_SCHEMAS.agentPatch);
    const extra = await app.inject({ method: "POST", url: "/x", payload: { name: "x", foo: 1 } });
    expect([extra.statusCode, extra.json()]).toEqual([400, { code: "CFG-8501", message: "不支持的字段: foo", details: { field: "foo" } }]);
    for (const apiEnabled of ["yes", "false"]) {
      const res = await app.inject({ method: "POST", url: "/x", payload: { apiEnabled } });
      expect([apiEnabled, res.statusCode, (res.json() as { details: unknown }).details]).toEqual([apiEnabled, 400, { field: "apiEnabled" }]);
    }
    expect((await app.inject({ method: "POST", url: "/x", payload: { name: "x", apiEnabled: true } })).statusCode).toBe(200);
    await app.close();
  });

  it("action routes (noBody): no body -> 200; {} -> 200; any field -> 400", async () => {
    const app = await bare(ROUTE_SCHEMAS.noBody);
    expect((await app.inject({ method: "POST", url: "/x" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/x", payload: {} })).statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: "/x", payload: { force: true } });
    expect([res.statusCode, (res.json() as { details: unknown }).details]).toEqual([400, { field: "force" }]);
    await app.close();
  });

  it("external routes stay open: undeclared fields pass, declared fields are still typed", async () => {
    const empty = await bare(ROUTE_SCHEMAS.externalNoBody);
    for (const payload of [undefined, {}, { reason: "x" }]) expect((await empty.inject({ method: "POST", url: "/x", ...(payload ? { payload } : {}) })).statusCode).toBe(200);
    await empty.close();
    const run = await bare(ROUTE_SCHEMAS.openRun);
    expect((await run.inject({ method: "POST", url: "/x", payload: { text: "hi", clientTag: "v2" } })).statusCode).toBe(200);
    expect((await run.inject({ method: "POST", url: "/x", payload: { text: 5 } })).statusCode).toBe(400);
    await run.close();
  });

  it("declared-but-unread fields removed (P1): agentCreate.status, agentPatch.instructions / version, schedulePatch.agentId -> 400", async () => {
    const props = (name: string) => Object.keys(schemas[name]!.body!.properties ?? {});
    expect(props("agentCreate")).not.toContain("status");
    expect(props("agentPatch")).not.toEqual(expect.arrayContaining(["instructions"]));
    expect(props("agentPatch")).not.toContain("version");
    expect(props("schedulePatch")).not.toContain("agentId");
    // Still declared and read where they belong.
    expect(props("agentCreate")).toEqual(expect.arrayContaining(["instructions", "version", "spec", "publish"]));
    expect(props("agentPatch")).toEqual(expect.arrayContaining(["name", "description", "status", "apiEnabled"]));
    expect(props("scheduleCreate")).toContain("agentId");
    const app = await bare(ROUTE_SCHEMAS.agentPatch);
    const res = await app.inject({ method: "POST", url: "/x", payload: { instructions: "x" } });
    expect([res.statusCode, (res.json() as { details: unknown }).details]).toEqual([400, { field: "instructions" }]);
    await app.close();
  });
});
