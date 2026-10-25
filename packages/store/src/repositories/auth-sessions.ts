import { execute, one } from "../db.js";

/**
 * Session store (migration 007). Callers pass hashes (SHA-256 hex of the cookie token), never the token itself.
 * Every lookup carries `expires_at > ?` with the caller's UTC "now", so an expired row is never accepted even when the
 * cleanup job has not run yet. Times are app-provided Date values (pool timezone "Z"), never the database NOW().
 */
export interface AuthSessionRow {
  token_hash: string;
  user_id: string;
  csrf_token: string;
  last_seen_at: Date;
  expires_at: Date;
}

export const authSessionsRepo = {
  async createAuthSession(input: { tokenHash: string; userId: string; csrfToken: string; now: Date; expiresAt: Date }): Promise<void> {
    await execute(
      "INSERT INTO auth_sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [input.tokenHash, input.userId, input.csrfToken, input.now, input.now, input.expiresAt],
    );
  },
  async getAuthSession(tokenHash: string, now: Date): Promise<AuthSessionRow | null> {
    return one<AuthSessionRow>(
      "SELECT token_hash, user_id, csrf_token, last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
      [tokenHash, now],
    );
  },
  /** Throttled activity stamp: only writes when the stored value is older than `staleBefore`. */
  async touchAuthSession(tokenHash: string, now: Date, staleBefore: Date): Promise<void> {
    await execute("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ? AND expires_at > ?", [now, tokenHash, staleBefore, now]);
  },
  async deleteAuthSession(tokenHash: string): Promise<void> {
    await execute("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
  },
  /** Drops one session row only if it is already expired (lazy cleanup on a rejected lookup). */
  async deleteExpiredAuthSession(tokenHash: string, now: Date): Promise<void> {
    await execute("DELETE FROM auth_sessions WHERE token_hash = ? AND expires_at <= ?", [tokenHash, now]);
  },
};
