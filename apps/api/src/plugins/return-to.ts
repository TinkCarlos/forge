/** Where OIDC login goes back to when returnTo is missing or unsafe (S-30). */
export const RETURN_TO_FALLBACK = "/next/";

/**
 * Open-redirect guard for OIDC returnTo (S-30). Accepts only a local path that
 * - starts with exactly one "/" (not "//" or "/\", also after one round of percent-decoding),
 * - has no control characters,
 * - resolves with new URL(returnTo, origin) to this site's origin.
 * Anything else becomes RETURN_TO_FALLBACK.
 */
export function safeReturnTo(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return RETURN_TO_FALLBACK;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return RETURN_TO_FALLBACK;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return RETURN_TO_FALLBACK;
  }
  for (const candidate of [raw, decoded]) {
    if (/^\/[/\\]/.test(candidate)) return RETURN_TO_FALLBACK;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return RETURN_TO_FALLBACK;
  }
  try {
    const base = new URL(origin);
    if (new URL(raw, base.origin).origin !== base.origin) return RETURN_TO_FALLBACK;
  } catch {
    return RETURN_TO_FALLBACK;
  }
  return raw;
}
