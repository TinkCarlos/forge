import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import type { PoolConnection as CorePoolConnection, QueryError } from "mysql2";
import { config } from "@forge/core";

const dbUrl = new URL(config.DATABASE_URL);

// AC / OPS-026i: second line of defence behind the vitest globalSetup. Only active under vitest (VITEST is set by the
// runner); refuses to create the pool for a database not ending with _test, before any connection is opened.
if (process.env.VITEST) {
  const database = decodeURIComponent(dbUrl.pathname.replace(/^\//, "")).trim();
  if (!database.endsWith("_test")) {
    throw new Error(`[test DB guard] 测试进程拒绝连接库「${database || "(空)"}」：库名必须以 _test 结尾（请用 TEST_DATABASE_URL 指向测试库）。`);
  }
}

export const pool: Pool = mysql.createPool({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ""),
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: "Z",
  charset: "utf8mb4",
});

// Item 10 (no-floating-promises): the promise pool re-emits the core pool's "connection" event with the core
// (callback-style) connection, so the typed promise `query` is really the callback API here. Use the callback: a failed
// SET is logged (error code only) instead of being an unobserved result.
pool.on("connection", (connection) => {
  (connection as unknown as CorePoolConnection).query("SET time_zone = '+00:00'", (error: QueryError | null) => {
    if (error) console.error(`DB session time_zone setup failed: ${error.code ?? "unknown"}`);
  });
});

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await pool.execute(sql, params as never[]);
  return result as ResultSetHeader;
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export function isRetryableWrite(error: unknown): boolean {
  const failure = error as { errno?: number; code?: string; message?: string };
  return failure.errno === 1062 || failure.errno === 1213 || failure.code === "ER_DUP_ENTRY" || failure.code === "ER_LOCK_DEADLOCK" || (failure.message ?? "").includes("Deadlock");
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export async function healthCheck(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
