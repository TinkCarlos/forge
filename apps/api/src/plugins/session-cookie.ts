import { isDevLike } from "@forge/core";

/** Fallback Max-Age when the caller passes no SESSION_TTL_SECONDS; equals SESSION_TTL_DEFAULT_SECONDS (8h). */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Options for the forge_session cookie. K-22: `secure` is on everywhere except an explicit NODE_ENV=development|test
 * (unset NODE_ENV is treated like production). Pure: takes the env/config explicitly.
 */
export function sessionCookieOptions(env: { NODE_ENV?: string | undefined; SESSION_TTL_SECONDS?: number | undefined }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !isDevLike(env),
    path: "/",
    // N-01: the cookie lives as long as the server session (config.SESSION_TTL_SECONDS).
    maxAge: env.SESSION_TTL_SECONDS ?? SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}
