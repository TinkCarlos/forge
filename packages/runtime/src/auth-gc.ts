import { pool } from "@forge/store";

// Session store (007): expired auth_sessions / auth_oidc_states rows are removed by the worker every 10 minutes, in
// batches (DELETE ... LIMIT 1000) so one run never holds long locks. GET_LOCK(name, 0) on the job's own connection makes
// it single-runner across workers: a worker that does not get the lock skips this round. Correctness never depends on
// this job: every lookup already filters expires_at > now.
export const AUTH_GC_INTERVAL_MS = 10 * 60 * 1000;
export const AUTH_GC_BATCH = 1000;
export const AUTH_GC_LOCK = "forge:auth-gc";

export interface AuthGcResult {
  ran: boolean;
  sessions: number;
  states: number;
}

export async function collectExpiredAuth(now: Date = new Date()): Promise<AuthGcResult> {
  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, 0) AS got", [AUTH_GC_LOCK]);
    if (Number((lockRows as Array<{ got: number | null }>)[0]?.got) !== 1) return { ran: false, sessions: 0, states: 0 };
    try {
      const deleteAll = async (table: "auth_sessions" | "auth_oidc_states"): Promise<number> => {
        let total = 0;
        for (;;) {
          const [result] = await conn.query(`DELETE FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`, [now, AUTH_GC_BATCH]);
          const affected = (result as { affectedRows: number }).affectedRows;
          total += affected;
          if (affected < AUTH_GC_BATCH) return total;
        }
      };
      const sessions = await deleteAll("auth_sessions");
      const states = await deleteAll("auth_oidc_states");
      return { ran: true, sessions, states };
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [AUTH_GC_LOCK]);
    }
  } finally {
    conn.release();
  }
}
