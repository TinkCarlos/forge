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

const DATABASE_URL_REQUIRED = "DATABASE_URL is required in every environment (no default). Set it explicitly.";

export type SecretName = keyof typeof DEV_SECRET_DEFAULTS;
const SECRET_NAMES = Object.keys(DEV_SECRET_DEFAULTS) as SecretName[];

/** NODE_ENV values recognised as-is. Anything else that is set triggers a startup warning (treated as production). */
const KNOWN_NODE_ENVS = ["development", "test", "production"] as const;

const envSchema = z.object({
  // K-22: no default. Unset means "not dev-like" (see isDevLike); config.NODE_ENV is the raw (trimmed) value.
  NODE_ENV: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  FORGE_PUBLIC_URL: z.string().default("http://localhost:3000"),
  // K-21 / OPS-001: required in every environment, no default. The error names the variable only, never a connection string.
  DATABASE_URL: z
    .string({ required_error: DATABASE_URL_REQUIRED })
    .trim()
    .min(1, DATABASE_URL_REQUIRED),
  REDIS_URL: z.string().optional(),
  // K-22: no schema default; resolved in parseConfig (dev defaults only for an explicit development/test NODE_ENV).
  FORGE_MASTER_KEY: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  API_KEY_PEPPER: z.string().optional(),
  FORGE_ADMIN_EMAIL: z.string().email().default("admin@forge.local"),
  FORGE_ADMIN_PASSWORD: z
    .string({ required_error: "未设置 FORGE_ADMIN_PASSWORD，请在 .env 中配置应急管理员密码（至少 8 位）" })
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
  const parsed = envSchema.safeParse(env);
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
    return parsed as Config;
  }
  if (missing.length) {
    warn(`[config] ${label}: using development default secrets for ${missing.join(", ")}. Never use these outside local development.`);
  }
  const resolved = { ...parsed } as Config;
  for (const name of missing) resolved[name] = DEV_SECRET_DEFAULTS[name];
  return resolved;
}
