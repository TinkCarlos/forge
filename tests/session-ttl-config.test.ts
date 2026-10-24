import { describe, expect, it, vi } from "vitest";
import { parseConfig, SESSION_TTL_DEFAULT_SECONDS } from "../packages/core/src/config-schema";

// session-cookie imports isDevLike from @forge/core; mock it with the pure module so no config / .env is loaded.
vi.mock("@forge/core", async () => ({ isDevLike: (await import("../packages/core/src/env-mode")).isDevLike }));
const { SESSION_COOKIE_MAX_AGE_SECONDS, sessionCookieOptions } = await import("../apps/api/src/plugins/session-cookie");

// N-01: SESSION_TTL_SECONDS (pure: config-schema and session-cookie only, no .env, no DB). Integer seconds,
// 300..86400, default 28800 (8h, the previous hard-coded TTL). Errors name the variable only, never the value.
const DB = ["my", "sql"].join("") + "://forge:placeholder@127.0.0.1:1/forge_test";
const dev = { NODE_ENV: "test", DATABASE_URL: DB, FORGE_ADMIN_PASSWORD: "dev-password-123" };
const quiet = { warn: () => undefined };
const MESSAGE = "SESSION_TTL_SECONDS must be an integer number of seconds between 300 and 86400";

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseConfig(env, quiet);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

describe("SESSION_TTL_SECONDS (N-01)", () => {
  it("defaults to 28800 (8h) when unset or empty", () => {
    expect(parseConfig(dev, quiet).SESSION_TTL_SECONDS).toBe(28800);
    expect(parseConfig({ ...dev, SESSION_TTL_SECONDS: "" }, quiet).SESSION_TTL_SECONDS).toBe(28800);
    expect(SESSION_TTL_DEFAULT_SECONDS).toBe(28800);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(SESSION_TTL_DEFAULT_SECONDS);
  });

  it("accepts integers in 300..86400 (whitespace trimmed)", () => {
    for (const [raw, value] of [["300", 300], ["3600", 3600], [" 7200 ", 7200], ["86400", 86400]] as const) {
      expect(parseConfig({ ...dev, SESSION_TTL_SECONDS: raw }, quiet).SESSION_TTL_SECONDS).toBe(value);
    }
  });

  it("refuses non-integers and out-of-range values; the message names the variable, not the value", () => {
    for (const raw of ["abc", "0", "-1", "299", "86401", "1.5", "1e3", "3600s", "99999999999999999999"]) {
      const message = errorOf({ ...dev, SESSION_TTL_SECONDS: raw });
      expect(message).toContain(MESSAGE);
      expect(message).not.toContain(raw.trim() === "0" ? "= 0" : raw);
    }
  });

  it("the session cookie Max-Age follows the configured TTL (fallback 8h)", () => {
    expect(sessionCookieOptions({ NODE_ENV: "test", SESSION_TTL_SECONDS: 3600 }).maxAge).toBe(3600);
    expect(sessionCookieOptions({ NODE_ENV: "test" }).maxAge).toBe(28800);
  });
});
