import { isIP } from "node:net";
import { z } from "zod";
import { allowlistProblems } from "./allowlist-format";
import { isDevLike } from "./env-mode";

export { DEV_LIKE_NODE_ENVS, isDevLike } from "./env-mode";

const bool = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

/**
 * Development-only secret defaults (K-22 / OPS-002). They are filled in only when NODE_ENV is explicitly "development"
 * or "test" (with a warning). With NODE_ENV unset, "production" or anything else, a missing secret or one still equal
 * to its default refuses startup; the error names the variables only, never their values.
 */
export const DEV_SECRET_DEFAULTS = {
  FORGE_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  SESSION_SECRET: "forge-dev-session-secret-change-me",
  API_KEY_PEPPER: "forge-dev-api-key-pepper-change-me",
} as const;

/** OPS-003: minimum length for SESSION_SECRET / API_KEY_PEPPER outside development/test (documented in deployment.md). */
export const MIN_SECRET_LENGTH = 32;
/** OPS-003: FORGE_MASTER_KEY is an AES-256-GCM key, so it must base64-decode to exactly this many bytes. */
export const MASTER_KEY_BYTES = 32;
/** N-01: session lifetime (seconds) when SESSION_TTL_SECONDS is unset: 8h, the previous hard-coded TTL. */
export const SESSION_TTL_DEFAULT_SECONDS = 8 * 60 * 60;
export const SESSION_TTL_MIN_SECONDS = 300;
export const SESSION_TTL_MAX_SECONDS = 86400;
const SESSION_TTL_MESSAGE = `SESSION_TTL_SECONDS must be an integer number of seconds between ${SESSION_TTL_MIN_SECONDS} and ${SESSION_TTL_MAX_SECONDS}`;
/** OPS-007: admin passwords shipped in .env.example; refused when NODE_ENV is not development/test. */
export const EXAMPLE_ADMIN_PASSWORDS: readonly string[] = ["change-me-now"];

/** OPS-006: an IPv4/IPv6 literal or an RFC 1123 hostname (no scheme, port, spaces; last label not all digits). */
export function isValidHost(value: string): boolean {
  if (isIP(value)) return true;
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1] ?? "");
}

function isMasterKey(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) return false;
  return Buffer.from(trimmed, "base64").length === MASTER_KEY_BYTES;
}

const DATABASE_URL_REQUIRED = "DATABASE_URL is required in every environment (no default). Set it explicitly.";

export type SecretName = keyof typeof DEV_SECRET_DEFAULTS;
const SECRET_NAMES = Object.keys(DEV_SECRET_DEFAULTS) as SecretName[];

/**
 * P3-18: secrets for which a whitespace-only value counts as unset (no environment may run with an empty key). The
 * DEV_SECRET_DEFAULTS ones then fall back to the development default (development/test, with a warning) or refuse
 * startup (elsewhere); FORGE_ADMIN_PASSWORD has no default and refuses startup naming the variable; the optional
 * client secrets behave as if not configured.
 */
export const BLANK_AS_UNSET_SECRETS = [...SECRET_NAMES, "FORGE_ADMIN_PASSWORD", "OIDC_CLIENT_SECRET", "AGENT_CONNECTOR_CLIENT_SECRET"] as const;

function blankSecretsUnset(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized = { ...env };
  for (const name of BLANK_AS_UNSET_SECRETS) {
    const value = normalized[name];
    if (typeof value === "string" && value.trim() === "") normalized[name] = undefined;
  }
  return normalized;
}

/** NODE_ENV values recognised as-is. Anything else that is set triggers a startup warning (treated as production). */
const KNOWN_NODE_ENVS = ["development", "test", "production"] as const;

const envSchema = z.object({
  // K-22: no default. Unset means "not dev-like" (see isDevLike); config.NODE_ENV is the raw (trimmed) value.
  NODE_ENV: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  // OPS-006: 1..65535; messages name the variable only.
  PORT: z.coerce
    .number({ error: "PORT must be an integer between 1 and 65535" })
    .int("PORT must be an integer between 1 and 65535")
    .min(1, "PORT must be an integer between 1 and 65535")
    .max(65535, "PORT must be an integer between 1 and 65535")
    .default(3000),
  // OPS-006: format check only; the default stays 0.0.0.0 (changing it is OPS-021, pending approval).
  HOST: z
    .string()
    .default("0.0.0.0")
    .refine(isValidHost, "HOST must be an IPv4/IPv6 address or a hostname (no scheme, port or spaces)"),
  FORGE_PUBLIC_URL: z.string().default("http://localhost:3000"),
  // K-21 / OPS-001: required in every environment, no default. The error names the variable only, never a connection string.
  DATABASE_URL: z
    .string({ error: DATABASE_URL_REQUIRED })
    .trim()
    .min(1, DATABASE_URL_REQUIRED),
  REDIS_URL: z.string().optional(),
  // K-22: no schema default; resolved in parseConfig (dev defaults only for an explicit development/test NODE_ENV).
  // OPS-003: when set (any environment) it must be a base64 AES-256 key; otherwise encrypt/decrypt throws at runtime.
  FORGE_MASTER_KEY: z
    .string()
    .optional()
    .refine((value) => value === undefined || value === "" || isMasterKey(value), `FORGE_MASTER_KEY must be base64 for exactly ${MASTER_KEY_BYTES} bytes`),
  SESSION_SECRET: z.string().optional(),
  API_KEY_PEPPER: z.string().optional(),
  FORGE_ADMIN_EMAIL: z.string().email().default("admin@forge.local"),
  FORGE_ADMIN_PASSWORD: z
    .string({ error: "未设置 FORGE_ADMIN_PASSWORD，请在 .env 中配置应急管理员密码（至少 8 位）" })
    .min(8, "FORGE_ADMIN_PASSWORD 至少 8 位"),
  FORGE_ADMIN_NAME: z.string().default("Platform Admin"),
  ALLOW_LOCAL_LOGIN: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  EMBEDDED_WORKER: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  /**
   * r5 §2.6: an approval expired at most this long ago is treated as rejected and the Run continues; longer -> the Run
   * fails with APR-2102. Integer seconds 60..86400, default 900; must exceed WORKER_POLL_MS (the expiry sweep interval).
   */
  APPROVAL_EXPIRED_GRACE_SECONDS: z.coerce
    .number({ error: "APPROVAL_EXPIRED_GRACE_SECONDS must be an integer number of seconds between 60 and 86400" })
    .int("APPROVAL_EXPIRED_GRACE_SECONDS must be an integer number of seconds between 60 and 86400")
    .min(60, "APPROVAL_EXPIRED_GRACE_SECONDS must be an integer number of seconds between 60 and 86400")
    .max(86400, "APPROVAL_EXPIRED_GRACE_SECONDS must be an integer number of seconds between 60 and 86400")
    .default(900),
  SCHEDULER_POLL_MS: z.coerce.number().int().positive().default(15000),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  MODEL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  TOOL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  DEFAULT_MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8000),
  DEFAULT_MAX_PARALLEL_TOOLS: z.coerce.number().int().positive().default(4),
  MAX_RUN_STEPS: z.coerce.number().int().positive().default(8),
  DEFAULT_MAX_COST_USD: z.coerce.number().positive().default(1),
  /** Deprecated: no longer bypasses the outbound guard (S-46). Use OUTBOUND_ALLOWLIST for specific host:port targets. */
  TOOL_ALLOW_PRIVATE_NETWORK: bool,
  /** Comma separated host:port targets exempt from the outbound private-address check (e.g. 127.0.0.1:8090 for the dev mock). Empty by default. */
  OUTBOUND_ALLOWLIST: z
    .string()
    .default("")
    // AD/AE: exact host:port only; each invalid entry is reported by position + value + reason (never the whole line).
    .superRefine((value, ctx) => {
      for (const message of allowlistProblems(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // N-01: server session TTL and forge_session cookie Max-Age. Digits only (no 1e3 / 1.5 / units), 300..86400.
  SESSION_TTL_SECONDS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim();
      if (!trimmed) return SESSION_TTL_DEFAULT_SECONDS;
      const seconds = /^[0-9]{1,6}$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!(seconds >= SESSION_TTL_MIN_SECONDS && seconds <= SESSION_TTL_MAX_SECONDS)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: SESSION_TTL_MESSAGE });
        return z.NEVER;
      }
      return seconds;
    }),
  LOG_LEVEL: z.string().default("info"),
  SSO_MODE: z.enum(["disabled", "optional", "required"]).default("optional"),
  SSO_TOKEN_VALIDATION_MODE: z
    .enum(["oidc", "agent-principal", "both"])
    .default("oidc"),
  SSO_ROLE_MAPPING_REQUIRED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),
  AGENT_CONNECTOR_ENABLED: bool,
  AGENT_CONNECTOR_INBOUND_ENABLED: bool,
  AGENT_CONNECTOR_OUTBOUND_ENABLED: bool,
  AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: bool,
  AGENT_URL: z.string().optional(),
  AGENT_TOKEN_URL: z.string().optional(),
  AGENT_CONNECTOR_ENVIRONMENT: z.enum(["test", "staging", "prod"]).default("test"),
  AGENT_CONNECTOR_SYSTEM_ID: z.string().optional(),
  AGENT_CONNECTOR_ID: z.string().optional(),
  AGENT_CONNECTOR_INSTANCE_ID: z.string().optional(),
  AGENT_CONNECTOR_CLIENT_ID: z.string().optional(),
  AGENT_CONNECTOR_CLIENT_SECRET: z.string().optional(),
  AGENT_CONNECTOR_CONFIG_KEY_ID: z.string().optional(),
  AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: z.string().optional(),
  AGENT_CONNECTOR_CACHE_PATH: z.string().optional(),
  CONNECTOR_PRINCIPAL_ISSUER: z.string().optional(),
  CONNECTOR_PRINCIPAL_AUDIENCE: z.string().optional(),
});

type ParsedEnv = z.infer<typeof envSchema>;
export type Config = Omit<ParsedEnv, SecretName> & Record<SecretName, string>;

export interface ParseConfigOptions {
  /** Receives the dev-default warning (variable names only). Defaults to console.warn. */
  warn?: (message: string) => void;
}

/** Validates an env object (pure; no process.env access) and returns the typed config, or throws. */
export function parseConfig(env: Record<string, string | undefined>, options: ParseConfigOptions = {}): Config {
  const parsed = envSchema.safeParse(blankSecretsUnset(env));
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".");
      return issue.message.startsWith(`${key} `) ? issue.message : `${key}: ${issue.message}`;
    });
    throw new Error(`Invalid configuration:\n${messages.join("\n")}`);
  }
  const warn = options.warn ?? ((message: string) => console.warn(message));
  // K-22: a set but unrecognised NODE_ENV (e.g. "Development", "staging") is treated like production; say so once.
  const nodeEnv = parsed.data.NODE_ENV;
  if (nodeEnv !== undefined && !(KNOWN_NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    warn(`[config] unrecognized NODE_ENV=${JSON.stringify(nodeEnv.slice(0, 64))}, treated as production (expected development, test or production).`);
  }
  // r5 §2.6: the expiry sweep runs once per worker cycle, so a cycle at least as long as the grace period could let an
  // approval pass the grace period before anyone looks at it.
  if (parsed.data.WORKER_POLL_MS >= parsed.data.APPROVAL_EXPIRED_GRACE_SECONDS * 1000) {
    throw new Error("Invalid configuration:\nWORKER_POLL_MS must be smaller than APPROVAL_EXPIRED_GRACE_SECONDS x 1000 (the expiry sweep runs once per worker cycle).");
  }
  const config = resolveSecrets(parsed.data, warn);
  // K-22: SSO is enforced everywhere except an explicit development/test NODE_ENV (unset is treated like production).
  if (!isDevLike(config) && config.SSO_MODE !== "required") {
    throw new Error(`SSO_MODE=required is mandatory unless NODE_ENV is explicitly development or test (${nodeEnvLabel(config.NODE_ENV)}).`);
  }
  if (!isDevLike(config) && config.ALLOW_LOCAL_LOGIN) {
    // Emergency admin remains available, but production should use SSO for normal users.
  }
  return config;
}

/**
 * K-22: secrets come from the environment. Only an explicit NODE_ENV=development|test may use DEV_SECRET_DEFAULTS
 * (and a warning naming the variables is emitted). Otherwise (unset, production, anything else) missing secrets or
 * secrets still equal to their dev default refuse startup. Messages contain variable names only.
 */
function nodeEnvLabel(nodeEnv: string | undefined): string {
  return nodeEnv ? `NODE_ENV=${nodeEnv}` : "NODE_ENV unset";
}

function resolveSecrets(parsed: ParsedEnv, warn: (message: string) => void): Config {
  const devAllowed = isDevLike(parsed);
  const missing = SECRET_NAMES.filter((name) => !parsed[name]);
  const label = nodeEnvLabel(parsed.NODE_ENV);
  if (!devAllowed) {
    if (missing.length) {
      throw new Error(
        `Missing required secrets (${label}): ${missing.join(", ")}. Set them in the environment; development defaults are only used when NODE_ENV is explicitly development or test.`,
      );
    }
    const stillDefault = SECRET_NAMES.filter((name) => parsed[name] === DEV_SECRET_DEFAULTS[name]);
    if (stillDefault.length) {
      throw new Error(`Refusing development default secrets (${label}): ${stillDefault.join(", ")}. Set unique values for them in the environment.`);
    }
    // OPS-003: blank or too-short secrets are as bad as missing ones.
    const tooShort = (["SESSION_SECRET", "API_KEY_PEPPER"] as const).filter((name) => (parsed[name] ?? "").trim().length < MIN_SECRET_LENGTH);
    if (tooShort.length) {
      throw new Error(`Secrets too short (${label}): ${tooShort.join(", ")}. Use at least ${MIN_SECRET_LENGTH} characters (e.g. openssl rand -base64 32).`);
    }
    // OPS-007: the admin password from .env.example must be changed before a non-development start.
    if (EXAMPLE_ADMIN_PASSWORDS.includes(parsed.FORGE_ADMIN_PASSWORD.trim())) {
      throw new Error(`Refusing the example FORGE_ADMIN_PASSWORD (${label}). Set a unique admin password in the environment before starting.`);
    }
    return parsed as Config;
  }
  if (missing.length) {
    warn(`[config] ${label}: using development default secrets for ${missing.join(", ")}. Never use these outside local development.`);
  }
  const resolved = { ...parsed } as Config;
  for (const name of missing) resolved[name] = DEV_SECRET_DEFAULTS[name];
  return resolved;
}
