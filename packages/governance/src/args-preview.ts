// Server-side, display-only summary of tool-call arguments for the approval list.
// Pure: no I/O. The raw arguments never leave the server; only this string does.

/** A key is sensitive when any of its word segments (see {@link keySegments}) is one of these. */
export const SENSITIVE_KEY_SEGMENTS: ReadonlySet<string> = new Set(["password", "token", "secret", "key", "authorization"]);
/** URL query parameters (case-insensitive) whose values are masked inside URL-looking string values. */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set(["token", "access_token", "key", "secret", "sig", "signature"]);
export const ARGS_PREVIEW_VALUE_MAX = 80;
export const ARGS_PREVIEW_TOTAL_MAX = 300;
const MASK = "***";
const MAX_DEPTH = 4;
const SECRET_VALUE = /^(?:bearer |basic )/i;
const SECRET_PREFIXES = ["sk-", "ghp_", "xox"];
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

/** Values that look like credentials regardless of their key: auth headers, well-known token prefixes, JWTs. */
export function isSecretValue(value: string): boolean {
  const text = value.trim();
  return SECRET_VALUE.test(text) || SECRET_PREFIXES.some((prefix) => text.startsWith(prefix)) || JWT_LIKE.test(text);
}

/** Masks sensitive query parameter values in an http(s) URL, leaving the rest of the string byte-for-byte. */
export function maskUrlQuery(value: string): string {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return value;
  try {
    new URL(text);
  } catch {
    return value;
  }
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

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function renderScalar(value: string | number | boolean | bigint | symbol): string {
  if (typeof value !== "string") return clip(String(value), ARGS_PREVIEW_VALUE_MAX);
  if (isSecretValue(value)) return MASK;
  return clip(maskUrlQuery(value), ARGS_PREVIEW_VALUE_MAX);
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
  return renderScalar(value as string | number | boolean | bigint | symbol);
}

function renderEntries(obj: Record<string, unknown>, depth: number): string {
  return Object.entries(obj)
    .map(([key, value]) => `${clip(key, ARGS_PREVIEW_VALUE_MAX)}=${isSensitiveKey(key) ? MASK : render(value, depth)}`)
    .join(", ");
}

/**
 * Builds the approval-list `args_preview`.
 * - `null`/`undefined` args -> `null` (no tool call / no args).
 * - Key masking: an object key any of whose word segments is password/token/secret/key/authorization
 *   (`api_key`, `apiKey`, `X-Api-Key`, `accessToken`; not `keyword`, `monkey`, `tokenizer`) -> value `***`, at any depth.
 * - Value masking (any key, any depth, array elements too): strings starting with `Bearer `/`Basic ` (case-insensitive),
 *   `sk-`, `ghp_`, `xox`, or JWT-like `eyJ….….…` -> `***`.
 * - http(s) URL strings: values of query params token/access_token/key/secret/sig/signature -> `***`, rest kept.
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
