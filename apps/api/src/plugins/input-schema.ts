import type { FastifyRequest } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { CRON_INVALID_MESSAGE, errors, type Role } from "@forge/core";

/**
 * Route input schemas (K-23 / K-24 / I-USR-02 / I-APR-34 / I-RUN-02 / S-25), as Fastify route schemas: plain JSON
 * schema compiled by Fastify's ajv at route registration. No zod in the route layer.
 *
 * Every string has maxLength and every array has maxItems (tests/input-schema.test.ts walks ROUTE_SCHEMAS).
 * Lengths mirror packages/store/src/schema.sql. A bad input is always 400 CFG-8501 (`errors.invalid`) with
 * `details.field`; the errorHandler maps nothing and DB errors are never translated to 400.
 *
 * Routes register `{ schema: ROUTE_SCHEMAS.x, attachValidation: true }` and call `assertValidInput(request)` at the
 * point where the old check stood, i.e. after the session / permission check and after the 404 lookup
 * (I-APR-34: an unknown approval stays 404; no session stays 401). Fastify therefore never rejects on its own.
 */

/**
 * Same options in apps/api/src/app.ts and the unit tests: no type coercion ("42" stays a string, 42 is not a string),
 * and no stripping (P1): Fastify's default ajv has removeAdditional: true, which would silently drop an undeclared
 * field from a closed body schema; with false it is a validation error, reported as 400 CFG-8501 by assertValidInput.
 * Only schemas that say additionalProperties: false are affected (the write body schemas below); the querystring
 * (`limit`) schemas stay open and there are no params schemas.
 */
export const AJV_CUSTOM_OPTIONS = { coerceTypes: false, removeAdditional: false } as const;

/** Every Role (literal, so pure unit tests that mock @forge/core still load; the type check below keeps it exhaustive). */
const LOCAL_ROLES = ["platform_admin", "org_admin", "builder", "operator", "auditor", "user"] as const satisfies readonly Role[];
const LOCAL_ROLES_EXHAUSTIVE: [Exclude<Role, (typeof LOCAL_ROLES)[number]>] extends [never] ? true : false = true;
void LOCAL_ROLES_EXHAUSTIVE;
const str = (maxLength: number) => ({ type: "string", maxLength }) as const;
const ID_MAX = 64; // ids are CHAR(26); 64 keeps an unknown long id a 404 rather than a new 400

/** Decimal digits only, no sign / decimal / exponent / leading zero, 1..max (max is a multiple of 100, >= 200). */
function limitPattern(max: number): string {
  const head = max / 100;
  return `^(?:[1-9][0-9]?|[1-${head - 1}][0-9]{2}|${max})$`;
}
const limitQuery = (max: number) =>
  ({ type: "object", properties: { limit: { type: "string", maxLength: String(max).length, pattern: limitPattern(max) } } }) as const;

// agents: key VARCHAR(64), name VARCHAR(128), description VARCHAR(1024), status VARCHAR(16);
// agent_versions: version VARCHAR(32), instructions MEDIUMTEXT (bounded at 1 MiB characters; the body limit is 2 MiB)
// P1: agentProps used to be shared by create and PATCH (44f7a55) and declared fields neither handler reads
// (create: status; PATCH: instructions / version, which belong to POST /agents/:id/versions). Those are gone, so
// sending them is 400 (closed body).
const agentProps = {
  name: str(128),
  description: str(1024),
} as const;

// schedules: key VARCHAR(64), name VARCHAR(128), cron VARCHAR(128), timezone VARCHAR(64), status active|disabled
export const SCHEDULE_STATUSES = ["active", "disabled"] as const;
// P1: agentId is create-only (PATCH never re-targets a schedule; it was declared via the shared props, 44f7a55).
const scheduleProps = {
  name: str(128),
  cron: str(128),
  timezone: str(64),
  serviceAccountId: str(ID_MAX),
} as const;

// F1 (P1) helpers. Numeric fields keep the old Number(...) leniency (number, numeric string, null) but are bounded;
// JSON fields accept an object or JSON text (jsonBody parses strings); run input may also be an array.
const MIB = 1_048_576;
const num = { type: ["number", "string", "null"], maxLength: 32 } as const;
const bool = { type: "boolean" } as const;
/** Strict integer in [minimum, maximum] (no strings, no null; coerceTypes is off). */
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum }) as const;
/** N-02 I-APP-03: requests per minute; 0 is not documented as "unlimited", so it is rejected. */
const RATE_LIMIT_PER_MINUTE = int(1, 100_000);
// P2 (QA 714b3f3 §4 P3-4): runs per app per day; integer, no negatives / NaN / null. 0 rejected (meaning undocumented).
const DAILY_QUOTA = int(1, 10_000_000);
/** N-03 I-MDL-04: provider request timeout in ms (default 120000 when omitted). */
const PROVIDER_TIMEOUT_MS = int(1_000, 600_000);
const jsonObject = (maxLength: number) => ({ type: ["object", "string"], maxLength }) as const;
const runInput = { type: ["object", "array", "string"], maxLength: MIB, maxItems: 1000 } as const;
// Item E: the external run entries (/open, /integration) also accept null for text / input (null counts as empty); input is an object (or its JSON text), not an array.
const externalText = { type: ["string", "null"], maxLength: MIB } as const;
const externalRunInput = { type: ["object", "string", "null"], maxLength: MIB } as const;
const arr = <T extends object>(maxItems: number, items: T) => ({ type: "array", maxItems, items }) as const;
const obj = <T extends Record<string, object>>(properties: T) => ({ type: "object", properties }) as const;
/**
 * P1 (architect): a write route's top-level body is closed; an undeclared field is rejected with 400 CFG-8501
 * (tests/body-additional-properties.test.ts). Nested free-form objects (plugin resources, JSON specs) stay open.
 */
const body = <T extends object>(schema: T) => ({ ...schema, additionalProperties: false }) as T & { readonly additionalProperties: false };
const capabilities = { type: ["array", "string"], maxLength: 4096, maxItems: 32, items: str(64) } as const;

export const ROUTE_SCHEMAS = {
  // P2 (QA): every field the handler reads is declared with a type (tests/route-body-fields.test.ts); agent PATCH used
  // to store `apiEnabled: "yes"` as 1 because the schema (44f7a55) listed only the string fields.
  agentCreate: { body: body({ type: "object", properties: { key: str(64), ...agentProps, instructions: str(1_048_576), version: str(32), spec: { type: ["object", "string"], maxLength: 1_048_576 }, publish: { type: "boolean" } } }) },
  agentPatch: { body: body({ type: "object", properties: { ...agentProps, status: str(16), apiEnabled: { type: "boolean" } } }) },
  // users: email VARCHAR(255), username VARCHAR(64), display_name VARCHAR(128), role VARCHAR(32), data_scope / status
  // VARCHAR(16); password is hashed (password_hash VARCHAR(255)), bounded at 256 so hashing cannot be abused.
  userCreate: {
    body: body({
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", minLength: 1, maxLength: 255, pattern: "^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$" },
        username: str(64),
        displayName: str(128),
        role: str(32),
        dataScope: str(16),
        status: str(16),
        password: str(256),
        // No orgUnitId (item 6): a new user always lands in the caller's department; sending it is 400 CFG-8501.
      },
    }),
  },
  // approvals: comment VARCHAR(1024)
  approvalDecide: {
    body: body({ type: "object", required: ["decision"], properties: { decision: { type: "string", maxLength: 16, enum: ["approved", "rejected"] }, comment: str(1024) } }),
  },
  runsList: { querystring: limitQuery(200) },
  auditList: { querystring: limitQuery(500) },
  // schedules.input_json: object or JSON text (jsonBody), bounded like other JSON bodies; enabled is a boolean.
  scheduleCreate: { body: body({ type: "object", properties: { key: str(64), ...scheduleProps, agentId: str(ID_MAX), input: { type: ["object", "string"], maxLength: 1_048_576 }, enabled: { type: "boolean" } } }) },
  schedulePatch: { body: body({ type: "object", properties: { ...scheduleProps, input: { type: ["object", "string"], maxLength: 1_048_576 }, status: { type: "string", maxLength: 16, enum: SCHEDULE_STATUSES } } }) },
  // F1 (P1): every write route that reads a body declares its schema (tests/route-body-schema-guard.test.ts).
  // agent_versions: version VARCHAR(32), changelog VARCHAR(2048), instructions MEDIUMTEXT
  agentVersionCreate: { body: body(obj({ version: str(32), instructions: str(MIB), spec: jsonObject(MIB), publish: bool, changelog: str(2048) })) },
  agentPublish: { body: body(obj({ versionId: str(ID_MAX) })) },
  agentRun: { body: body(obj({ versionId: str(ID_MAX), text: str(MIB), input: runInput, threadId: str(ID_MAX) })) },
  // api_apps: key 64, name 128, description 1024, status 16, webhook_url 2048; api_keys.name 128
  appCreate: {
    body: body(obj({ key: str(64), name: str(128), description: str(1024), scopes: arr(32, str(64)), webhookUrl: str(2048), webhookSecret: str(4096), rateLimitPerMinute: RATE_LIMIT_PER_MINUTE, dailyQuota: DAILY_QUOTA })),
  },
  appPatch: {
    body: body(obj({ name: str(128), description: str(1024), status: str(16), scopes: arr(32, str(64)), webhookUrl: str(2048), webhookSecret: str(4096), rateLimitPerMinute: RATE_LIMIT_PER_MINUTE, dailyQuota: DAILY_QUOTA })),
  },
  apiKeyCreate: { body: body(obj({ name: str(128) })) },
  // service_accounts: key 64, name 128, description 1024, role 32, data_scope 32, status 16
  serviceAccountCreate: { body: body(obj({ key: str(64), name: str(128), description: str(1024), role: str(32), dataScope: str(32) })) },
  serviceAccountPatch: { body: body(obj({ name: str(128), description: str(1024), role: str(32), dataScope: str(32), status: str(16) })) },
  // users: role 32, data_scope 16, status 16. No orgUnitId (item 6): this route cannot move a user; sending it is 400.
  userPatch: { body: body(obj({ role: str(32), dataScope: str(16), status: str(16) })) },
  // oidc_role_mappings: agent_role_code 100, agent_role_name 100, local_role 32
  // P2: localRole must be a known role (enum); mapRoles also ignores legacy rows with an unknown local_role.
  roleMappingUpsert: { body: body(obj({ agentRoleCode: str(100), agentRoleName: str(100), localRole: { type: "string", maxLength: 32, enum: LOCAL_ROLES } })) },
  // mcp_servers: key 64, name 128, transport 16, url 2048, status 16
  mcpCreate: { body: body(obj({ key: str(64), name: str(128), url: str(2048), headers: jsonObject(65_536), transport: str(16) })) },
  mcpPatch: { body: body(obj({ name: str(128), url: str(2048), headers: jsonObject(65_536), status: str(16) })) },
  // skills: key 64, name 128, description 1024, status 16; skill_versions: version 32, content_md MEDIUMTEXT
  skillCreate: { body: body(obj({ key: str(64), name: str(128), description: str(1024), content: str(MIB), version: str(32), publish: bool })) },
  skillPatch: { body: body(obj({ name: str(128), description: str(1024), status: str(16) })) },
  skillVersionCreate: { body: body(obj({ version: str(32), content: str(MIB), publish: bool })) },
  // tool_sources: key 64, name 128, base_url 2048
  toolSourceImport: { body: body(obj({ key: str(64), name: str(128), baseUrl: str(2048), spec: jsonObject(MIB), headers: jsonObject(65_536) })) },
  // llm_providers: key 64, name 128, protocol 32, base_url 2048, status 16; llm_models: key 128, display_name 128
  providerCreate: {
    body: body(obj({ key: str(64), name: str(128), protocol: str(32), baseUrl: str(2048), apiKey: str(4096), headers: jsonObject(65_536), timeoutMs: PROVIDER_TIMEOUT_MS })),
  },
  providerPatch: {
    body: body(obj({ name: str(128), protocol: str(32), baseUrl: str(2048), apiKey: str(4096), headers: jsonObject(65_536), timeoutMs: PROVIDER_TIMEOUT_MS, status: str(16) })),
  },
  modelCreate: {
    body: body(obj({ key: str(128), displayName: str(128), capabilities, contextWindow: num, maxOutputTokens: num, inputPrice: num, outputPrice: num })),
  },
  modelPatch: {
    body: body(obj({ displayName: str(128), capabilities, contextWindow: num, maxOutputTokens: num, inputPrice: num, outputPrice: num, status: str(16) })),
  },
  // plugins: key 128, version 32, type 32, name 128; nested resources bounded per kind (100 each)
  pluginInstall: {
    body: body(obj({
      key: str(128),
      version: str(32),
      type: str(32),
      name: str(128),
      manifest: jsonObject(65_536),
      resources: obj({
        agents: arr(100, obj({ key: str(64), name: str(128), description: str(1024), version: str(32), instructions: str(MIB), spec: jsonObject(MIB) })),
        skills: arr(100, obj({ key: str(64), name: str(128), description: str(1024), content: str(MIB) })),
        mcp: arr(100, obj({ key: str(64), name: str(128), url: str(2048), headers: jsonObject(65_536) })),
        providers: arr(
          100,
          obj({
            key: str(64), name: str(128), protocol: str(32), baseUrl: str(2048), apiKey: str(4096), headers: jsonObject(65_536),
            models: arr(100, obj({ key: str(128), displayName: str(128), capabilities })),
          }),
        ),
      }),
    })),
  },
  // runs: input JSON; threads.id CHAR(26); agents.key 64
  // External callers (Connector /integration/v1/*, open platform /open/*): fields and types declared, body NOT
  // closed (architect P1: only admin / console write routes are closed; external clients may send extra fields).
  integrationRun: { body: obj({ agentKey: str(64), text: externalText, input: externalRunInput }) },
  openRun: { body: obj({ text: externalText, input: externalRunInput, threadId: str(ID_MAX) }) },
  // users.email 255; password bounded at 256 like userCreate
  localLogin: { body: body(obj({ email: str(255), password: str(256) })) },
  // P1: write routes that take no body (actions such as logout, cancel, enable / disable / run, refresh, test,
  // replay, uninstall). No body and {} both pass; any field is 400 on the closed one. External cancels stay open.
  noBody: { body: body(obj({})) },
  externalNoBody: { body: obj({}) },
} as const;

/** Messages that differ from the generic ones (kept from the previous checks). */
const FIELD_MESSAGES: Record<string, string> = {
  "email.pattern": "email 格式无效",
  "email.minLength": "缺少字段: email",
  "decision.enum": "decision 必须为 approved/rejected",
};

type AjvError = { keyword: string; instancePath: string; params: Record<string, unknown> };

function messageFor(error: AjvError, field: string, limitMax: string | undefined): string {
  // `limit` (I-RUN-02 / S-25): one message whatever failed (type, length or pattern), naming the route's maximum.
  if (field === "limit" && limitMax) return `limit 必须是 1-${limitMax} 之间的整数`;
  const custom = FIELD_MESSAGES[`${field}.${error.keyword}`];
  if (custom) return custom;
  switch (error.keyword) {
    case "required":
      return `缺少字段: ${field}`;
    case "type":
      if (!field) return "请求参数必须是 JSON 对象";
      return error.params.type === "string" ? `${field} 必须是字符串` : `${field} 类型无效`;
    case "maxLength":
      return `${field} 不能超过 ${String(error.params.limit)} 个字符`;
    case "minLength":
      return `${field} 不能为空`;
    case "maxItems":
      return `${field} 不能超过 ${String(error.params.limit)} 项`;
    case "enum":
      return `${field} 只能是 ${(error.params.allowedValues as unknown[]).join(" 或 ")}`;
    case "pattern":
      return `${field} 格式无效`;
    case "additionalProperties":
      return `不支持的字段: ${field}`;
    default:
      return `${field || "请求参数"} 无效`;
  }
}

/**
 * Runs the route's compiled schema for `part` on the request (a non-object body counts as {} like bodyOf) and throws
 * 400 CFG-8501 with details.field for the first error. Requires the route to be registered with that schema part.
 */
export function assertValidInput(request: FastifyRequest, part: "body" | "querystring" = "body"): void {
  const validate = request.getValidationFunction(part);
  if (!validate) throw new Error(`route ${request.routeOptions.url ?? ""} has no ${part} schema`);
  const raw = part === "body" ? request.body : request.query;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (validate(value)) return;
  const error = (validate.errors?.[0] ?? { keyword: "invalid", instancePath: "", params: {} }) as AjvError;
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  const field =
    error.keyword === "required" ? String(error.params.missingProperty)
    : error.keyword === "additionalProperties" ? [path, String(error.params.additionalProperty)].filter(Boolean).join(".")
    : path;
  const schema = request.routeOptions.schema as { querystring?: { properties?: { limit?: { pattern?: string } } } } | undefined;
  const limitMax = /\|(\d+)\)\$$/.exec(schema?.querystring?.properties?.limit?.pattern ?? "")?.[1];
  throw errors.invalid(messageFor(error, field, limitMax), field ? { field } : undefined);
}

/** `limit` from an already validated querystring, or the default when absent. */
export function limitParam(request: FastifyRequest, fallback: number): number {
  const limit = (request.query as Record<string, unknown> | undefined)?.limit;
  return typeof limit === "string" ? Number(limit) : fallback;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isValidCron(cron: string, timezone: string): boolean {
  // F2: standard 5-field cron only (minute hour day month weekday). The parser also takes 6-field (seconds) and pads
  // short expressions, which the scheduler and the console do not support; empty / 4-field / 6-field -> invalid.
  if (cron.trim().split(/\s+/).filter(Boolean).length !== 5) return false;
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next();
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective cron + timezone after a create/patch: timezone first (I-SCH-04: an invalid timezone is reported as a
 * timezone error, not as a cron error), then cron against that timezone. Throws 400 CFG-8501. Callers pass the cron
 * through normalizeCron (@forge/core) first, so the accepted macros arrive here as 5-field expressions.
 */
export function assertScheduleTiming(cron: string, timezone: string): void {
  if (!isValidTimezone(timezone)) throw errors.invalid("时区无效", { field: "timezone" });
  if (!isValidCron(cron, timezone)) throw errors.invalid(CRON_INVALID_MESSAGE, { field: "cron" });
}
