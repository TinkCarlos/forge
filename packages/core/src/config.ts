import "dotenv/config";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  FORGE_PUBLIC_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("mysql://forge:forge_dev_password@127.0.0.1:3306/forge"),
  REDIS_URL: z.string().optional(),
  FORGE_MASTER_KEY: z
    .string()
    .default("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="),
  SESSION_SECRET: z.string().default("forge-dev-session-secret-change-me"),
  API_KEY_PEPPER: z.string().default("forge-dev-api-key-pepper-change-me"),
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
  TOOL_ALLOW_PRIVATE_NETWORK: bool,
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

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${messages.join("\n")}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production" && config.SSO_MODE !== "required") {
    throw new Error("Production requires SSO_MODE=required");
  }
  if (config.NODE_ENV === "production" && config.ALLOW_LOCAL_LOGIN) {
    // Emergency admin remains available, but production should use SSO for normal users.
  }
  return config;
}

export const config = loadConfig();
