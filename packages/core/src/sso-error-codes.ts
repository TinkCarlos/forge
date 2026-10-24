/**
 * P3-04 / item 11: the only codes a browser SSO error redirect may carry (`/next/sign-in?ssoError=<code>`). Anything
 * else (an unexpected error, a code outside this list) is sent as SSO_FALLBACK_CODE. The console maps each code to
 * fixed text; the raw value is never shown.
 * - HTP-4003: OUTBOUND_BLOCKED_CODE (outbound.ts), written as a literal so this module stays import-free;
 *   tests/sso-error-codes-core.test.ts pins the two equal.
 * - SSO-1212: the IdP answered the callback with `error=` (e.g. access_denied); its error / error_description are dropped.
 *
 * Pure module: no imports, no runtime config, safe for a client bundle (like the K-33 constants in ids.ts).
 */
export const SSO_FALLBACK_CODE = "SYS-9001";

export const SSO_ERROR_CODES: ReadonlySet<string> = new Set([
  "HTP-4003",
  "SSO-1201", "SSO-1202", "SSO-1203", "SSO-1204", "SSO-1205", "SSO-1206",
  "SSO-1207", "SSO-1208", "SSO-1209", "SSO-1210", "SSO-1211", "SSO-1212",
  SSO_FALLBACK_CODE,
]);
