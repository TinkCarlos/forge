import { describe, expect, it } from "vitest";
import { pool } from "@forge/store";

// Item 10 (needs a *_test DB): the pool's "connection" hook (SET time_zone, now through the callback API so its result
// is observed) still sets every new session to UTC.
describe("DB session time zone", () => {
  it("a fresh pool connection runs in +00:00", async () => {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query("SELECT @@session.time_zone AS tz");
      expect((rows as Array<{ tz: string }>)[0]?.tz).toBe("+00:00");
    } finally {
      conn.release();
    }
  });
});
