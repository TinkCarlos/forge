import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Pure (no DB, no .env): @forge/core would parse the process config on import, so only its error factory is stubbed.
// Route input schemas are Fastify route schemas (JSON schema, compiled by Fastify's ajv) - no zod. Each test builds a
// bare Fastify app with the same ajv options as apps/api/src/app.ts and the real ROUTE_SCHEMAS.
import { ForgeError } from "../packages/core/src/errors/forge-error.js";
vi.mock("@forge/core", async () => {
  const { ForgeError } = await import("../packages/core/src/errors/forge-error.js");
  return {
  ...(await import("../packages/core/src/cron.js")),
  ForgeError,
  errors: { invalid: (m: string, details?: unknown) => new ForgeError("CFG-8501", { message: m, httpStatus: 400, details: details, retryable: false }) },
  };
});
import { AJV_CUSTOM_OPTIONS, ROUTE_SCHEMAS, assertScheduleTiming, assertValidInput, limitParam } from "../apps/api/src/plugins/input-schema.js";

type Name = keyof typeof ROUTE_SCHEMAS;
type Result = { status: number; code?: string; message?: string; field?: string; body?: unknown };

async function harness(): Promise<FastifyInstance> {
  const app = Fastify({ ajv: { customOptions: AJV_CUSTOM_OPTIONS } });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as InstanceType<typeof ForgeError>;
    reply.status(e.httpStatus ?? 500).send({ code: e.code, message: e.message, field: (e.details as { field?: string } | undefined)?.field });
  });
  for (const name of Object.keys(ROUTE_SCHEMAS) as Name[]) {
    const schema = ROUTE_SCHEMAS[name];
    if ("body" in schema) {
      app.post(`/body/${name}`, { schema, attachValidation: true }, async (request) => {
        assertValidInput(request);
        return { ok: true, body: request.body };
      });
    } else {
      app.get(`/query/${name}`, { schema, attachValidation: true }, async (request) => {
        assertValidInput(request, "querystring");
        return { ok: true, limit: limitParam(request, 7) };
      });
    }
  }
  await app.ready();
  return app;
}
let appP: Promise<FastifyInstance> | null = null;
async function post(name: Name, payload: unknown): Promise<Result> {
  const app = await (appP ??= harness());
  const res = await app.inject({ method: "POST", url: `/body/${name}`, payload: payload as Record<string, unknown> });
  const json = res.json() as Result;
  return { ...json, status: res.statusCode };
}
async function get(name: Name, qs: string): Promise<Result & { limit?: number }> {
  const app = await (appP ??= harness());
  const res = await app.inject({ method: "GET", url: `/query/${name}${qs}` });
  return { ...(res.json() as Result), status: res.statusCode };
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; maxLength?: number; maxItems?: number };
function walk(schema: JsonSchema, path: string, out: string[]): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("string") && typeof schema.maxLength !== "number") out.push(`${path}: string without maxLength`);
  if (types.includes("array") && typeof schema.maxItems !== "number") out.push(`${path}: array without maxItems`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${path}.${key}`, out);
  if (schema.items) walk(schema.items, `${path}[]`, out);
}

describe("route schemas are JSON schema with bounds everywhere", () => {
  it("every string has maxLength and every array has maxItems", () => {
    const missing: string[] = [];
    for (const [name, parts] of Object.entries(ROUTE_SCHEMAS)) for (const [part, schema] of Object.entries(parts)) walk(schema as JsonSchema, `${name}.${part}`, missing);
    expect(missing).toEqual([]);
  });
  it("no zod in the route layer; routes pass ROUTE_SCHEMAS to Fastify", async () => {
    const fs = await import("node:fs");
    const read = (p: string) => fs.readFileSync(new URL(`../apps/api/src/${p}`, import.meta.url), "utf8");
    expect(read("plugins/input-schema.ts")).not.toMatch(/from "zod"/);
    for (const [file, names] of Object.entries({
      "routes/admin/agents.ts": ["agentCreate", "agentPatch"],
      "routes/admin/identity.ts": ["userCreate", "auditList"],
      "routes/admin/runs.ts": ["runsList", "approvalDecide"],
      "routes/admin/schedules.ts": ["scheduleCreate", "schedulePatch"],
    })) {
      const src = read(file);
      expect(src, file).not.toMatch(/from "zod"/);
      for (const name of names) expect(src, `${file} ${name}`).toContain(`schema: ROUTE_SCHEMAS.${name}`);
    }
  });
});

describe("400 CFG-8501 with details.field and the previous messages", () => {
  it("K-23: agent name over 128 / description over 1024 / version over 32 -> 400; 128 is fine; extra fields pass through", async () => {
    expect(await post("agentCreate", { key: "k", name: "a".repeat(200) })).toMatchObject({ status: 400, code: "CFG-8501", field: "name", message: "name 不能超过 128 个字符" });
    expect(await post("agentPatch", { description: "d".repeat(1025) })).toMatchObject({ code: "CFG-8501", field: "description" });
    expect(await post("agentCreate", { key: "k", version: "v".repeat(33) })).toMatchObject({ code: "CFG-8501", field: "version" });
    expect(await post("agentPatch", { name: 42 })).toMatchObject({ code: "CFG-8501", field: "name", message: "name 必须是字符串" });
    expect(await post("agentCreate", { key: "k", name: "a".repeat(128), spec: { x: 1 } })).toMatchObject({ status: 200, body: { spec: { x: 1 } } });
  });

  it("I-USR-02: missing email / email=abc / over-long fields -> 400; padded email passes", async () => {
    expect(await post("userCreate", {})).toMatchObject({ code: "CFG-8501", field: "email", message: "缺少字段: email" });
    expect(await post("userCreate", { email: "abc" })).toMatchObject({ code: "CFG-8501", field: "email", message: "email 格式无效" });
    expect(await post("userCreate", { email: `${"e".repeat(251)}@b.co` })).toMatchObject({ field: "email", message: "email 不能超过 255 个字符" });
    expect(await post("userCreate", { email: "a@b.co", username: "u".repeat(65) })).toMatchObject({ field: "username" });
    expect(await post("userCreate", { email: "a@b.co", password: "p".repeat(257) })).toMatchObject({ field: "password" });
    expect(await post("userCreate", { email: "a@b.co", role: "r".repeat(33) })).toMatchObject({ field: "role" });
    expect(await post("userCreate", { email: " a@forge.local " })).toMatchObject({ status: 200 });
  });

  it("I-APR-34: missing / unknown decision, comment of 1025 -> 400; 1024 is fine", async () => {
    expect(await post("approvalDecide", {})).toMatchObject({ code: "CFG-8501", field: "decision" });
    expect(await post("approvalDecide", { decision: "nope" })).toMatchObject({ field: "decision", message: "decision 必须为 approved/rejected" });
    expect(await post("approvalDecide", { decision: "approved", comment: "c".repeat(1025) })).toMatchObject({ code: "CFG-8501", field: "comment" });
    expect(await post("approvalDecide", { decision: "rejected", comment: "c".repeat(1024) })).toMatchObject({ status: 200 });
  });

  it("K-24 / I-ERR-22: schedule bad status / non-string cron / over-long key -> 400", async () => {
    expect(await post("schedulePatch", { status: "paused" })).toMatchObject({ code: "CFG-8501", field: "status", message: "status 只能是 active 或 disabled" });
    expect(await post("schedulePatch", { cron: 5 })).toMatchObject({ field: "cron" });
    expect(await post("scheduleCreate", { key: "k".repeat(65) })).toMatchObject({ field: "key" });
    expect(await post("scheduleCreate", { cron: "c".repeat(129) })).toMatchObject({ field: "cron", message: "cron 不能超过 128 个字符" });
  });

  it("I-RUN-02 / S-25: limit=abc/1.5/-1/0/1e2/empty/over max/repeated -> 400; absent -> default; digits pass", async () => {
    for (const qs of ["?limit=abc", "?limit=1.5", "?limit=-1", "?limit=0", "?limit=1e2", "?limit=", "?limit=201", "?limit=0010"]) {
      expect(await get("runsList", qs), qs).toMatchObject({ status: 400, code: "CFG-8501", field: "limit", message: "limit 必须是 1-200 之间的整数" });
    }
    expect(await get("runsList", "?limit=1&limit=2")).toMatchObject({ status: 400, code: "CFG-8501", field: "limit", message: "limit 必须是 1-200 之间的整数" });
    expect(await get("auditList", "?limit=201")).toMatchObject({ status: 400, message: "limit 必须是 1-200 之间的整数" });
    expect(await get("runsList", "")).toMatchObject({ status: 200, limit: 7 });
    expect(await get("runsList", "?limit=200")).toMatchObject({ status: 200, limit: 200 });
    expect(await get("runsList", "?limit=1")).toMatchObject({ status: 200, limit: 1 });
  });

  it("I-SCH-04: invalid timezone says timezone, not cron; invalid cron says cron", () => {
    const err = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        const f = e as InstanceType<typeof ForgeError>;
        return { code: f.code, message: f.message, field: (f.details as { field?: string }).field };
      }
      return null;
    };
    expect(err(() => assertScheduleTiming("not a cron", "Asia/Shanghai"))).toEqual({ code: "CFG-8501", field: "cron", message: "只支持 5 段 cron 或 @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly" });
    expect(err(() => assertScheduleTiming("0 9 * * *", "Mars/Olympus"))).toEqual({ code: "CFG-8501", field: "timezone", message: "时区无效" });
    expect(err(() => assertScheduleTiming("0 9 * * *", ""))).toMatchObject({ field: "timezone" });
    expect(err(() => assertScheduleTiming("0 9 * * *", "Asia/Shanghai"))).toBeNull();
  });
});

describe("validation lives in the route schema, not the error handler (P1-01 3)", () => {
  it("errors.ts maps no MySQL data errors to 400", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../apps/api/src/plugins/errors.ts", import.meta.url), "utf8");
    for (const code of ["ER_DATA_TOO_LONG", "ER_TRUNCATED_WRONG_VALUE", "ER_BAD_NULL_ERROR", "WARN_DATA_TRUNCATED"]) expect(src).not.toContain(code);
  });
});
