import { config, safeEqual, signSession, errors } from "@forge/core";

export interface PageCursor { createdAt: string; id: string }
export function readPageCursor(value: string | undefined): PageCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PageCursor;
    if (Object.keys(cursor).length !== 2 || !/^[a-zA-Z0-9_]{26}$/.test(cursor.id) || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw errors.invalid("分页游标无效");
    return cursor;
  } catch { throw errors.invalid("分页游标无效", { field: "cursor" }); }
}
export function pageResult<T extends { id: string; created_at: Date | string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id })).toString("base64url") : null };
}

// Separate signed cursors leave existing list contracts unchanged.
export function boundPageCursor(cursor: PageCursor, context: string): string {
  const payload = Buffer.from(JSON.stringify({ ...cursor, context })).toString("base64url");
  return `${payload}.${signSession(`forge-page:${payload}`, config.SESSION_SECRET)}`;
}
export function readBoundPageCursor(value: string | undefined, context: string): PageCursor | null {
  if (!value) return null;
  try {
    if (value.length > 2048) throw errors.invalid("分页游标无效");
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined || !safeEqual(signature, signSession(`forge-page:${payload}`, config.SESSION_SECRET))) throw errors.invalid("分页游标无效");
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw errors.invalid("分页游标无效");
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || row.context !== context) throw errors.invalid("分页条件已变化");
    const encoded = Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url");
    return readPageCursor(encoded);
  } catch { throw errors.invalid("分页游标无效，请重新查询", { field: "cursor" }); }
}
