// K-22: the single source of truth for "is this a development-like environment". Pure (no imports, no process.env
// default) so it can be used from config parsing, scripts and unit tests without loading .env or a database.

/** NODE_ENV values treated as development-like. Unset / empty / "production" / anything else is NOT dev-like. */
export const DEV_LIKE_NODE_ENVS = ["development", "test"] as const;

/**
 * True only when the raw NODE_ENV is explicitly "development" or "test". Everything else (unset, empty, production,
 * staging, typos) is treated like production: secrets required, secure cookies, SSO enforced, db reset refused.
 */
export function isDevLike(env: { NODE_ENV?: string | undefined }): boolean {
  const value = env.NODE_ENV?.trim() ?? "";
  return (DEV_LIKE_NODE_ENVS as readonly string[]).includes(value);
}
