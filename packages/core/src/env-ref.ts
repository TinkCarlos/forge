import { ForgeError } from "./index";

/**
 * AG (S-61): `env:NAME` values in MCP / provider / tool-source headers (and provider apiKey) used to be expanded to
 * process.env[NAME] at request time, so anyone with mcp/model/tool.manage could send server secrets to any public URL.
 * Expansion is removed. Writes carrying `env:` (case-insensitive, surrounding whitespace ignored) are refused with
 * 400 CFG-8504; a stored `env:` value found at runtime fails the call with the same code instead of being sent.
 * Error texts never contain the referenced value. Named references bound to a target host is a next-round design item.
 */
export const ENV_REF_CODE = "CFG-8504";
export const ENV_REF_MESSAGE = "不支持 env: 引用";

export function envRefError(): ForgeError {
  return new ForgeError(ENV_REF_CODE, ENV_REF_MESSAGE, 400);
}

export function isEnvRef(value: unknown): boolean {
  return typeof value === "string" && /^env:/i.test(value.trim());
}

function headerObject(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Config write check: throws 400 CFG-8504 if any header value or the apiKey is an `env:` reference. */
export function assertNoEnvRefs(input: { headers?: unknown; apiKey?: unknown }): void {
  if (isEnvRef(input.apiKey)) throw envRefError();
  for (const value of Object.values(headerObject(input.headers))) {
    if (isEnvRef(value)) throw envRefError();
  }
}

/** Stored headers as literal strings (non-strings dropped). Throws CFG-8504 on a stored `env:` value; never expands it. */
export function literalHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerObject(raw))) {
    if (typeof value !== "string") continue;
    if (isEnvRef(value)) throw envRefError();
    headers[key] = value;
  }
  return headers;
}

export function isEnvRefError(error: unknown): boolean {
  return error instanceof ForgeError && error.code === ENV_REF_CODE;
}
