import { isDevLike } from "@forge/core";

export const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Options for the forge_session cookie. K-22: `secure` is on everywhere except an explicit NODE_ENV=development|test
 * (unset NODE_ENV is treated like production). Pure: takes the env/config explicitly.
 */
export function sessionCookieOptions(env: { NODE_ENV?: string | undefined }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !isDevLike(env),
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}
