// Server-side, display-only summary of tool-call arguments for the approval list.
// Pure: no I/O. The raw arguments never leave the server; only this string does.

/** Key names whose values are always replaced by `***` (matched anywhere in the key, case-insensitive). */
export const SENSITIVE_ARG_KEY = /password|token|secret|key|authorization/i;
export const ARGS_PREVIEW_VALUE_MAX = 80;
export const ARGS_PREVIEW_TOTAL_MAX = 300;
const MASK = "***";
const MAX_DEPTH = 4;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
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
  return clip(String(value), ARGS_PREVIEW_VALUE_MAX);
}

function renderEntries(obj: Record<string, unknown>, depth: number): string {
  return Object.entries(obj)
    .map(([key, value]) => `${clip(key, ARGS_PREVIEW_VALUE_MAX)}=${SENSITIVE_ARG_KEY.test(key) ? MASK : render(value, depth)}`)
    .join(", ");
}

/**
 * Builds the approval-list `argsPreview`.
 * - `null`/`undefined` args -> `null` (no tool call / no args).
 * - Object keys matching {@link SENSITIVE_ARG_KEY} have their value replaced by `***`, at any nesting depth
 *   (including objects inside arrays); the whole subtree under such a key is dropped.
 * - Every other scalar value is stringified and cut to {@link ARGS_PREVIEW_VALUE_MAX} chars (ending in `…`).
 * - The whole preview is cut to {@link ARGS_PREVIEW_TOTAL_MAX} chars (ending in `…`).
 */
export function buildArgsPreview(args: unknown): string | null {
  if (args === null || args === undefined) return null;
  const text = typeof args === "object" && !Array.isArray(args)
    ? renderEntries(args as Record<string, unknown>, 0)
    : render(args, 0);
  return clip(text, ARGS_PREVIEW_TOTAL_MAX);
}
