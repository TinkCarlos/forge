import {MESSAGE_CATALOG_HTTP_SCHEMAS} from "./message-config.js";
import {MESSAGE_ACTION_HTTP_SCHEMAS} from "./message-config.js";
import {MESSAGE_HTTP_SCHEMAS} from "./message-config.js";
import { JOB_HTTP_SCHEMAS } from "./job-api.js";
import { ROLE_SCHEMAS } from "./roles.js";
import { SECRET_SCHEMAS } from "./secrets.js";
import { ADDITIONAL_ROLE_IDS, USER_CREATE_BODY, USER_PATCH_BODY, USER_PASSWORD_BODY, USER_SSO_BINDING_BODY, AUTH_PASSWORD_BODY, USER_LIST_QUERY, AUDIT_LIST_QUERY } from "./identity.js";
import { API_KEY_CREATE_BODY, API_KEY_ROTATE_BODY } from "./api-keys.js";

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
const secretId = { type: ["string", "null"], minLength: 26, maxLength: 26, pattern: "^[A-Za-z0-9_]{26}$" } as const;
const headerSecretRefs = jsonObject(65_536);
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
/**
 * P2 (architect on e2d2c5f): app scopes are listed one by one. assertScope never treats `*` as a wildcard, so a scope
 * containing `*` ("*", "runs:*") would look like "everything" and grant nothing: 400 CFG-8501 (field scopes.N).
 */
const APP_SCOPES = arr(32, { type: "string", maxLength: 64, pattern: "^[^*]*$" } as const);
const capabilities = { type: ["array", "string"], maxLength: 4096, maxItems: 32, items: str(64) } as const;

export const ROUTE_SCHEMAS = {
  messageTemplateCreate:MESSAGE_CATALOG_HTTP_SCHEMAS.templateCreate,messageTemplatePatch:MESSAGE_CATALOG_HTTP_SCHEMAS.templatePatch,messageRuleCreate:MESSAGE_CATALOG_HTTP_SCHEMAS.ruleCreate,messageRulePatch:MESSAGE_CATALOG_HTTP_SCHEMAS.rulePatch,
  messageTest:MESSAGE_ACTION_HTTP_SCHEMAS.test,messageRetry:MESSAGE_ACTION_HTTP_SCHEMAS.retry,messageCancel:MESSAGE_ACTION_HTTP_SCHEMAS.cancel,messageDeliveries:MESSAGE_ACTION_HTTP_SCHEMAS.deliveries,
  messageVersions:MESSAGE_HTTP_SCHEMAS.versionPage,
  messageChannelCreate:MESSAGE_HTTP_SCHEMAS.channelCreate,messageChannelPatch:MESSAGE_HTTP_SCHEMAS.channelPatch,messagePage:MESSAGE_HTTP_SCHEMAS.page,
  jobCreate: JOB_HTTP_SCHEMAS.create, jobPatch: JOB_HTTP_SCHEMAS.patch, jobList: JOB_HTTP_SCHEMAS.list, jobEmpty: JOB_HTTP_SCHEMAS.empty,
  ...ROLE_SCHEMAS,
  secretCreate: SECRET_SCHEMAS.create,
  secretRotate: SECRET_SCHEMAS.rotate,
  secretPatch: SECRET_SCHEMAS.patch,
  secretList: SECRET_SCHEMAS.list,
  secretDelete: SECRET_SCHEMAS.remove,
  // P2 (QA): every field the handler reads is declared with a type (tests/route-body-fields.test.ts); agent PATCH used
  // to store `apiEnabled: "yes"` as 1 because the schema (44f7a55) listed only the string fields.
  agentCreate: { body: body({ type: "object", properties: { key: str(64), ...agentProps, instructions: str(1_048_576), version: str(32), spec: { type: ["object", "string"], maxLength: 1_048_576 }, publish: { type: "boolean" } } }) },
  agentPatch: { body: body({ type: "object", properties: { ...agentProps, status: str(16), apiEnabled: { type: "boolean" } } }) },
  userCreate: { body: body(USER_CREATE_BODY) },
  // approvals: comment VARCHAR(1024)
  approvalDecide: {
    body: body({ type: "object", required: ["decision"], properties: { decision: { type: "string", maxLength: 16, enum: ["approved", "rejected"] }, comment: str(1024) } }),
  },
  runsList: { querystring: limitQuery(200) },
  auditList: { querystring: AUDIT_LIST_QUERY },
  usersList: { querystring: USER_LIST_QUERY },
  userPassword: { body: body(USER_PASSWORD_BODY) },
  userSsoBinding: { body: body(USER_SSO_BINDING_BODY) },
  authPassword: { body: body(AUTH_PASSWORD_BODY) },
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
    body: body(obj({ key: str(64), name: str(128), description: str(1024), scopes: APP_SCOPES, webhookUrl: str(2048), webhookSecret: str(4096), webhookSecretId: secretId, rateLimitPerMinute: RATE_LIMIT_PER_MINUTE, dailyQuota: DAILY_QUOTA })),
  },
  appPatch: {
    body: body(obj({ name: str(128), description: str(1024), status: str(16), scopes: APP_SCOPES, webhookUrl: str(2048), webhookSecret: str(4096), webhookSecretId: secretId, rateLimitPerMinute: RATE_LIMIT_PER_MINUTE, dailyQuota: DAILY_QUOTA })),
  },
  apiKeyCreate: { body: body(API_KEY_CREATE_BODY) },
  apiKeyRotate: { body: body(API_KEY_ROTATE_BODY) },
  // service_accounts: key 64, name 128, description 1024, role 32, data_scope 32, status 16
  serviceAccountCreate: { body: body(obj({ key: str(64), name: str(128), description: str(1024), additionalRoleIds:ADDITIONAL_ROLE_IDS, role: str(32), dataScope: str(32) })) },
  serviceAccountPatch: { body: body(obj({ name: str(128), description: str(1024), additionalRoleIds:ADDITIONAL_ROLE_IDS, role: str(32), dataScope: str(32), status: str(16) })) },
  // Account profile, department and authorization share one revision.
  userPatch: { body: body(USER_PATCH_BODY) },
  // oidc_role_mappings: agent_role_code 100, agent_role_name 100, local_role 32
  // P2: localRole must be a known role (enum); mapRoles also ignores legacy rows with an unknown local_role.
  roleMappingUpsert: { body: body(obj({ agentRoleCode: str(100), agentRoleName: str(100), localRole: { ...str(32),pattern:"^[a-z][a-z0-9_]{0,31}$" } })) },
  // mcp_servers: key 64, name 128, transport 16, url 2048, status 16
  mcpCreate: { body: body(obj({ key: str(64), name: str(128), url: str(2048), headers: jsonObject(65_536), headerSecretRefs, transport: str(16) })) },
  mcpPatch: { body: body(obj({ name: str(128), url: str(2048), headers: jsonObject(65_536), headerSecretRefs, status: str(16) })) },
  // skills: key 64, name 128, description 1024, status 16; skill_versions: version 32, content_md MEDIUMTEXT
  skillCreate: { body: body(obj({ key: str(64), name: str(128), description: str(1024), content: str(MIB), version: str(32), publish: bool })) },
  skillPatch: { body: body(obj({ name: str(128), description: str(1024), status: str(16) })) },
  skillVersionCreate: { body: body(obj({ version: str(32), content: str(MIB), publish: bool })) },
  // tool_sources: key 64, name 128, base_url 2048
  toolSourceImport: { body: body(obj({ key: str(64), name: str(128), baseUrl: str(2048), spec: jsonObject(MIB), headers: jsonObject(65_536), headerSecretRefs })) },
  // llm_providers: key 64, name 128, protocol 32, base_url 2048, status 16; llm_models: key 128, display_name 128
  providerCreate: {
    body: body(obj({ key: str(64), name: str(128), protocol: str(32), baseUrl: str(2048), apiKey: str(4096), secretId, headers: jsonObject(65_536), headerSecretRefs, timeoutMs: PROVIDER_TIMEOUT_MS })),
  },
  providerPatch: {
    body: body(obj({ name: str(128), protocol: str(32), baseUrl: str(2048), apiKey: str(4096), secretId, headers: jsonObject(65_536), headerSecretRefs, timeoutMs: PROVIDER_TIMEOUT_MS, status: str(16) })),
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
