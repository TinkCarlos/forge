/**
 * Item 7: reading a stored JSON object column (`spec_json`, `headers_json`). MySQL JSON columns reject invalid JSON, but a
 * JSON *string* value holding text that does not parse to an object (written by older code or by hand) is possible.
 * Such a value is treated as {} and reported as one warning naming the table, column and record id only; the stored
 * text is never logged (it may hold header secrets). null / undefined are {} without a warning.
 */
export interface StoredJsonRef {
  table: string;
  column: string;
  id: string;
}

export type StoredJsonWarn = (entry: { level: "warn"; msg: string; table: string; column: string; id: string }) => void;

const defaultWarn: StoredJsonWarn = (entry) => console.warn(JSON.stringify(entry));

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function storedJsonObject(raw: unknown, ref: StoredJsonRef, warn: StoredJsonWarn = defaultWarn): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  if (isObject(value)) return value;
  warn({ level: "warn", msg: "stored JSON is not an object, using {}", table: ref.table, column: ref.column, id: ref.id });
  return {};
}
