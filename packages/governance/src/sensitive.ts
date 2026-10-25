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
const SECRET_VALUE_PREFIX = /^(?:bearer |basic |sk-|gh[opsu]_|github_pat_|xox)/i;
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

/** Segments that, next to a `token`/`tokens` segment, mark a token-count key (`max_tokens`, `total_tokens`, `tokenCount`, `token_limit`). */
export const TOKEN_COUNT_SEGMENTS: ReadonlySet<string> = new Set([
  "max", "min", "input", "output", "prompt", "completion", "total", "num", "count", "limit", "used", "remaining", "reasoning", "cached",
]);
const TOKEN_SEGMENTS: ReadonlySet<string> = new Set(["token", "tokens"]);

/**
 * True when any word segment of the key is in {@link SENSITIVE_KEY_SEGMENTS}. Exception: in a token-count key (a `token`/`tokens`
 * segment together with a {@link TOKEN_COUNT_SEGMENTS} segment) the `token`/`tokens` segment does not count, so `max_tokens` and
 * `tokenCount` are not sensitive, while `access_token`, `authToken`, `tokens` and `max_api_key` still are. Only the key is exempted:
 * secret-looking values ({@link isSecretValue}) are masked under any key.
 */
export function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  const tokenCount = segments.some((segment) => TOKEN_SEGMENTS.has(segment)) && segments.some((segment) => TOKEN_COUNT_SEGMENTS.has(segment));
  return segments.some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment) && !(tokenCount && TOKEN_SEGMENTS.has(segment)));
}

/** Values that look like credentials regardless of their key: auth headers, well-known token prefixes (all case-insensitive), JWTs. */
export function isSecretValue(value: string): boolean {
  const text = value.trim();
  return SECRET_VALUE_PREFIX.test(text) || JWT_LIKE.test(text);
}

// Prose credentials inside a longer string (P2, QA 714b3f3; MASK-01). Only the credential becomes `***`; the sentence stays.
//
// MASK-01 known prefixes: masked whether or not the token contains a digit (the old "needs a digit" condition let
// digit-free random tokens through). Lead boundary `(^|[^\w-])` so the prefix is not the tail of a longer word.
// - `Bearer ` + at least 16 base64url characters (`.~+/=` allowed). The older rule (at least 6 with a digit) stays too.
// - `sk-` + at least 16 key characters (so `sk-learn`, `sk-ii` stay readable).
// - GitHub `ghp_` / `gho_` / `ghs_` / `ghu_` / `github_pat_` + at least 16; Slack `xox[abprs]-` + at least 8.
// - AWS access key id: `AKIA` / `ASIA` + exactly 16 `[A-Z0-9]`.
// - JWT: three base64url segments separated by `.`, the first two both starting with `eyJ`.
// Not covered (P2, left as is on purpose): bare hex / base64 runs with neither a keyword nor a known prefix.
const B64URL = "A-Za-z0-9_\\-";
const PROSE_BEARER = /\b(bearer\s+)(?:(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{6,}|[A-Za-z0-9._~+/=-]{16,})/gi;
// Basic: base64-looking (a digit, + / =, or an inner lower->upper switch), so "Basic Authentication" stays readable.
const PROSE_BASIC = /\b(Basic\s+)(?=[A-Za-z0-9+/=]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g;
const PROSE_SK = /(^|[^\w-])sk-[A-Za-z0-9_-]{16,}/g;
const PROSE_GITHUB = /(^|[^\w-])(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{16,}/g;
const PROSE_SLACK = /(^|[^\w-])xox[abprs]-[A-Za-z0-9-]{8,}/g;
const PROSE_AWS_KEY_ID = /(^|[^\w-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const PROSE_JWT = new RegExp(`(^|[^${B64URL}.])eyJ[${B64URL}]*\\.eyJ[${B64URL}]*\\.[${B64URL}]+`, "g");
// Keyword key-value: the whole key in front of `:` / `=` / `：` must be exactly one keyword (case-insensitive). The lead
// `(^|[^\w-])` and "keyword, optional spaces, then the separator" make it a whole-key match, so `max_tokens=`,
// `token 用量:`, `tokenizer=`, `secretary:` and a `secret` without a separator do not match. The value is masked whole,
// including an auth scheme (`Authorization: Bearer abc` -> `Authorization: ***`).
const PROSE_KEY_VALUE =
  /(^|[^\w-])((?:password|passwd|pwd|secret|client[_-]?secret|authorization|x-api-key|api[ _-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|密码|口令|密钥|令牌)\s*[=:：]\s*)(?!\*\*\*)((?:(?:bearer|basic)\s+)?[^\s,;，；。"'()（）<>]+)/gi;

/** Masks prose-style credentials inside free text; returns the input unchanged when there are none. */
export function maskProseSecrets(value: string): string {
  return value
    .replace(PROSE_KEY_VALUE, (_m, lead: string, key: string) => `${lead}${key}${MASK}`)
    .replace(PROSE_BEARER, `$1${MASK}`)
    .replace(PROSE_BASIC, `$1${MASK}`)
    .replace(PROSE_SK, `$1${MASK}`)
    .replace(PROSE_GITHUB, `$1${MASK}`)
    .replace(PROSE_SLACK, `$1${MASK}`)
    .replace(PROSE_AWS_KEY_ID, `$1${MASK}`)
    .replace(PROSE_JWT, `$1${MASK}`);
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
