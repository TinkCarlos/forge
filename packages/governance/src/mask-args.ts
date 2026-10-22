// Deep masking of tool-call arguments / user input / audit details before they leave the server.
// Pure: no I/O, never mutates its input. Uses exactly the rules of the approval-list args_preview (sensitive.ts).
import { isSecretValue, isSensitiveKey, MASK, maskQueryString, parseJsonContainer, UNPARSEABLE_JSON } from "./sensitive.js";

/** Objects/arrays nested deeper than this (root = depth 0) are replaced whole by `***`. */
export const MASK_ARGS_MAX_DEPTH = 32;

interface Ctx {
  /** Containers on the current path (cycle detection; shared non-circular references are fine). */
  ancestors: WeakSet<object>;
  /** Number of values replaced so far; used to return untouched embedded JSON byte-for-byte. */
  changes: number;
}

/**
 * Returns a copy of `value` with the same structure and keys, where sensitive values are replaced by `"***"`:
 * - a value under a sensitive key (segment match, {@link isSensitiveKey}) -> `***` whole (null/undefined are kept);
 * - secret-looking strings (`Bearer `/`Basic `/`sk-`/`ghp_`/`xox` prefixes, JWT-like) under any key -> `***`;
 * - URL-looking strings -> sensitive query values masked ({@link maskQueryString});
 * - JSON-like strings -> parsed, masked with the same rules and re-serialised (still a string; returned unchanged when
 *   nothing inside was masked); JSON-like strings that do not parse -> `***`;
 * - circular references and containers deeper than {@link MASK_ARGS_MAX_DEPTH} -> `***`.
 * Nothing is truncated. Numbers, booleans, null and Date values pass through.
 */
export function maskArgsDeep(value: unknown): unknown {
  return maskValue(value, 0, { ancestors: new WeakSet(), changes: 0 });
}

function masked(ctx: Ctx): string {
  ctx.changes += 1;
  return MASK;
}

function maskValue(value: unknown, depth: number, ctx: Ctx): unknown {
  if (typeof value === "string") return maskString(value, depth, ctx);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (depth >= MASK_ARGS_MAX_DEPTH || ctx.ancestors.has(value)) return masked(ctx);
  ctx.ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1, ctx));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && item !== null && item !== undefined ? masked(ctx) : maskValue(item, depth + 1, ctx);
    }
    return out;
  } finally {
    ctx.ancestors.delete(value);
  }
}

function maskString(value: string, depth: number, ctx: Ctx): string {
  if (isSecretValue(value)) return masked(ctx);
  const embedded = parseJsonContainer(value);
  if (embedded === UNPARSEABLE_JSON) return masked(ctx);
  if (embedded !== undefined) {
    const before = ctx.changes;
    const inner = maskValue(embedded, depth + 1, ctx);
    return ctx.changes === before ? value : JSON.stringify(inner);
  }
  const query = maskQueryString(value);
  if (query !== value) ctx.changes += 1;
  return query;
}
