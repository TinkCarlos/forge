// Shared secret-detection rules used by both the approval-list `args_preview` (args-preview.ts) and `maskArgsDeep`
// (mask-args.ts). Pure: no I/O. Change the rules here only, so the two outputs never disagree on what is a secret.

/** A key is sensitive when any of its word segments (see {@link keySegments}) is one of these. */
export const SENSITIVE_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "password", "passwords", "pwd", "passwd",
  "token", "tokens",
  "secret", "secrets",
  "key", "keys",
  "authorization",
  "credential", "credentials",
  "cookie", "cookies",
]);
/** URL query parameters (case-insensitive) whose values are masked inside URL-looking string values. */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set(["token", "access_token", "key", "secret", "sig", "signature"]);
/** Replacement for every masked value. */
export const MASK = "***";
const SECRET_VALUE_PREFIX = /^(?:bearer |basic |sk-|ghp_|xox)/i;
const JWT_LIKE = /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/;

/**
 * Splits a key into lowercase word segments on `_`, `-`, `.`, spaces, camelCase and acronym boundaries,
 * and letter/digit boundaries: `X-Api-Key` -> [x, api, key], `APIKey` -> [api, key], `accessToken2` -> [access, token, 2].
 */
export function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  return keySegments(key).some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment));
}

/** Values that look like credentials regardless of their key: auth headers, well-known token prefixes (all case-insensitive), JWTs. */
export function isSecretValue(value: string): boolean {
  const text = value.trim();
  return SECRET_VALUE_PREFIX.test(text) || JWT_LIKE.test(text);
}

/** True when the trimmed string starts with http:// or https:// and `new URL` accepts it. */
export function isHttpUrl(value: string): boolean {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Masks sensitive query parameter values in an http(s) URL, leaving the rest of the string byte-for-byte. Non-URLs are returned as-is. */
export function maskUrlQuery(value: string): string {
  if (!isHttpUrl(value)) return value;
  const text = value.trim();
  const hashAt = text.indexOf("#");
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : text.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return value;
  const masked = beforeHash
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      let name = pair.slice(0, eq);
      try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
      return SENSITIVE_QUERY_PARAMS.has(name.toLowerCase()) ? `${pair.slice(0, eq)}=${MASK}` : pair;
    })
    .join("&");
  return `${beforeHash.slice(0, queryAt)}?${masked}${hash}`;
}

/** URL-looking text: contains `://`, or (trimmed) starts with `/` or `www.`. */
export function looksLikeUrl(value: string): boolean {
  const text = value.trim();
  return text.includes("://") || text.startsWith("/") || /^www\./i.test(text);
}

/**
 * Query masking for string values:
 * - parseable http(s) URL -> only sensitive parameter values become `***` ({@link maskUrlQuery});
 * - other URL-looking text ({@link looksLikeUrl}: unparseable `…://…`, non-http schemes, `/path`, `www.…`) containing `?`
 *   -> everything after the first `?` becomes `***` (the `?` is kept);
 * - anything else (e.g. a sentence like `明天开会?`) is unchanged.
 */
export function maskQueryString(value: string): string {
  if (isHttpUrl(value)) return maskUrlQuery(value);
  const at = value.indexOf("?");
  if (at === -1 || !looksLikeUrl(value)) return value;
  return `${value.slice(0, at + 1)}${MASK}`;
}

/** Marker returned by {@link parseJsonContainer} for JSON-like text that does not parse. */
export const UNPARSEABLE_JSON: unique symbol = Symbol("unparseable-json");

/**
 * JSON-like: the trimmed value starts with `{` or `[`, and the next non-whitespace character is `"`, `'`, `{` or `[`
 * (so `{"a":…`, `{'token':…`, `[{…`, `["…` are JSON-like; `[草稿] 周报`, `{名字} 你好`, `[1, 2]` are not).
 */
export function looksLikeJson(value: string): boolean {
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  return /^["'{[]/.test(text.slice(1).trimStart());
}

/**
 * For JSON-like strings ({@link looksLikeJson}): the parsed object/array, or {@link UNPARSEABLE_JSON} when it does not
 * parse (it may be truncated/broken JSON with secrets in it, so the caller masks it entirely). Anything else -> undefined.
 */
export function parseJsonContainer(value: string): object | typeof UNPARSEABLE_JSON | undefined {
  if (!looksLikeJson(value)) return undefined;
  const text = value.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : UNPARSEABLE_JSON;
  } catch {
    return UNPARSEABLE_JSON;
  }
}
