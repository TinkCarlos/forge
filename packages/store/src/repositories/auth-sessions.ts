import type { RowDataPacket } from "mysql2/promise";
import { execute, one, transaction } from "../db.js";

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

export interface AuthOidcStateRow {
  verifier: string;
  nonce: string;
  return_to: string;
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
  async createOidcState(input: { stateHash: string; verifier: string; nonce: string; returnTo: string; now: Date; expiresAt: Date }): Promise<void> {
    await execute(
      "INSERT INTO auth_oidc_states (state_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [input.stateHash, input.verifier, input.nonce, input.returnTo, input.now, input.expiresAt],
    );
  },
  /** returnTo of a live state, without consuming it. */
  async peekOidcStateReturnTo(stateHash: string, now: Date): Promise<string | null> {
    const row = await one<{ return_to: string }>("SELECT return_to FROM auth_oidc_states WHERE state_hash = ? AND expires_at > ?", [stateHash, now]);
    return row?.return_to ?? null;
  },
  /**
   * One-time use: SELECT ... FOR UPDATE + DELETE in one transaction, so of concurrent callbacks with the same state
   * (on any instance) exactly one gets the row. null when missing, already used or expired.
   */
  async consumeOidcState(stateHash: string, now: Date): Promise<AuthOidcStateRow | null> {
    return transaction(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT verifier, nonce, return_to FROM auth_oidc_states WHERE state_hash = ? AND expires_at > ? FOR UPDATE",
        [stateHash, now],
      );
      const row = rows[0] as AuthOidcStateRow | undefined;
      if (!row) return null;
      await conn.query("DELETE FROM auth_oidc_states WHERE state_hash = ?", [stateHash]);
      return { verifier: row.verifier, nonce: row.nonce, return_to: row.return_to };
    });
  },
};
