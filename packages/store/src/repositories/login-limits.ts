import type { RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core";
import { execute, transaction } from "../db.js";

export const loginLimitsRepo = {
  async reserveLoginAttempts(limits: Array<{ key: string; maximum: number; windowMs: number }>, now = new Date()): Promise<void> {
    await execute("DELETE FROM auth_login_limits WHERE expires_at <= ? LIMIT 100", [now]);
    await transaction(async conn => {
      for (const limit of [...limits].sort((a, b) => a.key.localeCompare(b.key))) {
        const expires = new Date(now.getTime() + limit.windowMs);
        await conn.execute("INSERT INTO auth_login_limits (key_hash, attempts, window_started_at, expires_at) VALUES (?, 0, ?, ?) ON DUPLICATE KEY UPDATE key_hash = key_hash", [limit.key, now, expires]);
        const [rows] = await conn.query<RowDataPacket[]>("SELECT attempts, expires_at FROM auth_login_limits WHERE key_hash = ? FOR UPDATE", [limit.key]);
        const row = rows[0]!;
        const expired = new Date(row.expires_at as string).getTime() <= now.getTime();
        if (!expired && Number(row.attempts) >= limit.maximum) {
          const seconds = Math.max(1, Math.ceil((new Date(row.expires_at as string).getTime() - now.getTime()) / 1000));
          throw new ForgeError("AUTH-1002", { details: { retryAfterSeconds: seconds }, headers: { "Retry-After": String(seconds) } });
        }
        if (expired) await conn.execute("UPDATE auth_login_limits SET attempts = 1, window_started_at = ?, expires_at = ? WHERE key_hash = ?", [now, expires, limit.key]);
        else await conn.execute("UPDATE auth_login_limits SET attempts = attempts + 1 WHERE key_hash = ?", [limit.key]);
      }
    });
  },
  async clearLoginAttempts(key: string): Promise<void> {
    await execute("DELETE FROM auth_login_limits WHERE key_hash = ?", [key]);
  },
};
