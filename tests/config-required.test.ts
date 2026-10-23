import { describe, expect, it } from "vitest";
// Import the pure schema module directly: no dotenv, no process.env, no database, no module side effects.
import { parseConfig } from "../packages/core/src/config-schema";

// K-21 (OPS-001): DATABASE_URL has no default in any environment.
const DB = "mysql://forge:placeholder@127.0.0.1:1/forge_test";
const admin = { FORGE_ADMIN_PASSWORD: "test-only-password-123" };
const secrets = {
  FORGE_MASTER_KEY: "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtISE=",
  SESSION_SECRET: "test-only-session-secret-unique",
  API_KEY_PEPPER: "test-only-api-key-pepper-unique",
};

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

describe("K-21: DATABASE_URL is required in every environment", () => {
  const envs: Array<[string, Record<string, string>]> = [
    ["development", { NODE_ENV: "development" }],
    ["test", { NODE_ENV: "test" }],
    ["production", { NODE_ENV: "production", SSO_MODE: "required", ...secrets }],
    ["unset", { ...secrets }],
  ];
  for (const [label, env] of envs) {
    it(`NODE_ENV ${label}: missing DATABASE_URL -> error naming only the variable`, () => {
      const message = errorOf(() => parseConfig({ ...admin, ...env }));
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toMatch(/mysql:\/\//i);
      expect(message).not.toMatch(/@127\.0\.0\.1|:3306/);
    });
    it(`NODE_ENV ${label}: empty / blank DATABASE_URL -> same error`, () => {
      for (const blank of ["", "   "]) {
        const message = errorOf(() => parseConfig({ ...admin, ...env, DATABASE_URL: blank }));
        expect(message).toContain("DATABASE_URL");
        expect(message).not.toMatch(/mysql:\/\//i);
      }
    });
  }
  it("an explicit DATABASE_URL is used as-is", () => {
    expect(parseConfig({ ...admin, ...secrets, NODE_ENV: "test", DATABASE_URL: DB }).DATABASE_URL).toBe(DB);
  });
});
