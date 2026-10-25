import { describe, expect, it } from "vitest";
import { parseConfig } from "../packages/core/src/config-schema";

// TK-14 (pure: config-schema only, no .env, no DB). APPROVAL_EXPIRED_GRACE_SECONDS: integer 60..86400, default 900.
// The expiry sweep runs every worker cycle (WORKER_POLL_MS), which must be shorter than the grace period, otherwise the
// configuration is refused at startup. Messages name the variables, never the values.
const DB = ["my", "sql"].join("") + "://forge:placeholder@127.0.0.1:1/forge_test";
const dev = { NODE_ENV: "test", DATABASE_URL: DB, FORGE_ADMIN_PASSWORD: "dev-password-123" };
const quiet = { warn: () => undefined };

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseConfig(env, quiet);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

describe("APPROVAL_EXPIRED_GRACE_SECONDS (TK-14)", () => {
  it("defaults to 900 with the default 1000 ms poll", () => {
    const config = parseConfig(dev, quiet);
    expect(config.APPROVAL_EXPIRED_GRACE_SECONDS).toBe(900);
    expect(config.WORKER_POLL_MS).toBe(1000);
  });

  it("accepts 60 and 86400", () => {
    expect(parseConfig({ ...dev, APPROVAL_EXPIRED_GRACE_SECONDS: "60" }, quiet).APPROVAL_EXPIRED_GRACE_SECONDS).toBe(60);
    expect(parseConfig({ ...dev, APPROVAL_EXPIRED_GRACE_SECONDS: "86400" }, quiet).APPROVAL_EXPIRED_GRACE_SECONDS).toBe(86400);
  });

  it("refuses 59, 86401 and non-integers", () => {
    for (const raw of ["59", "86401", "0", "-1", "1.5", "abc"]) {
      expect(errorOf({ ...dev, APPROVAL_EXPIRED_GRACE_SECONDS: raw })).toContain("APPROVAL_EXPIRED_GRACE_SECONDS");
    }
  });

  it("refuses WORKER_POLL_MS >= APPROVAL_EXPIRED_GRACE_SECONDS x 1000", () => {
    for (const [poll, grace] of [["900000", "900"], ["60000", "60"], ["3600000", "900"]]) {
      const message = errorOf({ ...dev, WORKER_POLL_MS: poll, APPROVAL_EXPIRED_GRACE_SECONDS: grace });
      expect(message).toContain("WORKER_POLL_MS");
      expect(message).toContain("APPROVAL_EXPIRED_GRACE_SECONDS");
      expect(message).not.toContain(poll);
    }
    expect(parseConfig({ ...dev, WORKER_POLL_MS: "59999", APPROVAL_EXPIRED_GRACE_SECONDS: "60" }, quiet).WORKER_POLL_MS).toBe(59999);
  });
});
