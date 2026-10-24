// Server-side, display-only summary of tool-call arguments for the approval list.
// Pure: no I/O. The raw arguments never leave the server; only this string does.
// The secret-detection rules live in sensitive.ts (shared with maskArgsDeep).
import { isSecretValue, isSensitiveKey, MASK, maskProseSecrets, maskQueryString, parseJsonContainer, UNPARSEABLE_JSON } from "./sensitive.js";

export {
  isHttpUrl,
  isSecretValue,
  isSensitiveKey,
  keySegments,
  looksLikeJson,
  looksLikeUrl,
  maskQueryString,
  maskUrlQuery,
  SENSITIVE_KEY_SEGMENTS,
  SENSITIVE_QUERY_PARAMS,
} from "./sensitive.js";

export const ARGS_PREVIEW_VALUE_MAX = 80;
export const ARGS_PREVIEW_TOTAL_MAX = 300;
const MAX_DEPTH = 4;

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
  return clip(maskProseSecrets(maskQueryString(value)), ARGS_PREVIEW_VALUE_MAX);
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
