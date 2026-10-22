import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import { config } from "@forge/core";

const dbUrl = new URL(config.DATABASE_URL);

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

pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'");
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
