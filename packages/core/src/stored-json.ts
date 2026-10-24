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

/** Item A: the shape a JSON field must have (input: object or array; manifest / resources: object; capabilities: string[]). */
export type JsonShape = "object" | "stringArray" | "objectOrArray";

export function jsonShapeMatches(value: unknown, shape: JsonShape): boolean {
  if (shape === "stringArray") return Array.isArray(value) && value.every((item) => typeof item === "string");
  return isObject(value) || (shape === "objectOrArray" && Array.isArray(value));
}

/**
 * Item A: storedJsonObject for any JsonShape. A value of the wrong shape (or text that does not parse to it) is {}
 * ([] for stringArray) with one warning naming table, column and id only. null / undefined → the same default, no warning.
 */
export function storedJsonValue(raw: unknown, ref: StoredJsonRef, shape: JsonShape, warn: StoredJsonWarn = defaultWarn): unknown {
  const empty = shape === "stringArray" ? [] : {};
  if (raw === null || raw === undefined) return empty;
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  if (jsonShapeMatches(value, shape)) return value;
  warn({ level: "warn", msg: `stored JSON is not ${shape}, using ${JSON.stringify(empty)}`, table: ref.table, column: ref.column, id: ref.id });
  return empty;
}
