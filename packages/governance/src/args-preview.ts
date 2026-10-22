// Server-side, display-only summary of tool-call arguments for the approval list.
// Pure: no I/O. The raw arguments never leave the server; only this string does.

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
export const ARGS_PREVIEW_VALUE_MAX = 80;
export const ARGS_PREVIEW_TOTAL_MAX = 300;
const MASK = "***";
const MAX_DEPTH = 4;
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

const UNPARSEABLE_JSON = Symbol("unparseable-json");

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
function parseJsonContainer(value: string): object | typeof UNPARSEABLE_JSON | undefined {
  if (!looksLikeJson(value)) return undefined;
  const text = value.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : UNPARSEABLE_JSON;
  } catch {
    return UNPARSEABLE_JSON;
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function renderScalar(value: string | number | boolean | bigint | symbol, depth: number): string {
  if (typeof value !== "string") return clip(String(value), ARGS_PREVIEW_VALUE_MAX);
  if (isSecretValue(value)) return MASK;
  // JSON-encoded bodies (e.g. body='{"password":"x"}') are masked with the same rules as real objects.
  // JSON-like text that does not parse is masked whole (it may be broken JSON with secrets in it).
  const embedded = parseJsonContainer(value);
  if (embedded === UNPARSEABLE_JSON) return MASK;
  if (embedded !== undefined) return render(embedded, depth);
  return clip(maskQueryString(value), ARGS_PREVIEW_VALUE_MAX);
}

function render(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[…]";
    return `[${value.map((item) => render(item, depth + 1)).join(", ")}]`;
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "{…}";
    return `{${renderEntries(value as Record<string, unknown>, depth + 1)}}`;
  }
  if (typeof value === "function") return "null";
  return renderScalar(value as string | number | boolean | bigint | symbol, depth);
}

function renderEntries(obj: Record<string, unknown>, depth: number): string {
  return Object.entries(obj)
    .map(([key, value]) => `${clip(key, ARGS_PREVIEW_VALUE_MAX)}=${isSensitiveKey(key) ? MASK : render(value, depth)}`)
    .join(", ");
}

/**
 * Builds the approval-list `args_preview`.
 * - `null`/`undefined` args -> `null` (no tool call / no args).
 * - Key masking: an object key any of whose word segments is in {@link SENSITIVE_KEY_SEGMENTS}
 *   (`api_key`, `apiKey`, `X-Api-Key`, `accessToken`, `DB_PWD`, `cookies`; not `keyword`, `monkey`, `tokenizer`, `secretary`)
 *   -> value `***`, at any depth.
 * - Value masking (any key, any depth, array elements too): strings starting with `Bearer `/`Basic `/`sk-`/`ghp_`/`xox`
 *   (case-insensitive), or JWT-like `eyJ….….…` -> `***`.
 * - Parseable http(s) URL strings: values of query params token/access_token/key/secret/sig/signature -> `***`, rest kept.
 *   Other URL-looking strings (`://`, leading `/` or `www.`) containing `?`: everything after the first `?` -> `***`.
 *   Plain text with `?` is left alone.
 * - JSON-like strings ({@link looksLikeJson}) are parsed and rendered/masked like nested objects; JSON-like strings that
 *   do not parse become `***`. Other bracket-prefixed text (`[草稿] 周报`) follows the normal string rules.
 * - Every other value is stringified and cut to {@link ARGS_PREVIEW_VALUE_MAX} chars (ending in `…`);
 *   the whole preview is cut to {@link ARGS_PREVIEW_TOTAL_MAX} chars.
 */
export function buildArgsPreview(args: unknown): string | null {
  if (args === null || args === undefined) return null;
  const text = typeof args === "object" && !Array.isArray(args)
    ? renderEntries(args as Record<string, unknown>, 0)
    : render(args, 0);
  return clip(text, ARGS_PREVIEW_TOTAL_MAX);
}
