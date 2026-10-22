import { describe, expect, it } from "vitest";
import { DEV_SECRET_DEFAULTS, parseConfig } from "@forge/core";

// parseConfig takes an explicit env object, so these tests never read or mutate process.env.
const base = { FORGE_ADMIN_PASSWORD: "test-only-password-123" };
const strong = {
  FORGE_MASTER_KEY: "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtISE=",
  SESSION_SECRET: "test-only-session-secret-unique",
  API_KEY_PEPPER: "test-only-api-key-pepper-unique",
};
const prod = { ...base, NODE_ENV: "production", SSO_MODE: "required" };

describe("parseConfig: production secret defaults", () => {
  it("development keeps working with the dev defaults", () => {
    const config = parseConfig({ ...base, NODE_ENV: "development" });
    expect(config.SESSION_SECRET).toBe(DEV_SECRET_DEFAULTS.SESSION_SECRET);
    expect(config.FORGE_MASTER_KEY).toBe(DEV_SECRET_DEFAULTS.FORGE_MASTER_KEY);
    expect(config.API_KEY_PEPPER).toBe(DEV_SECRET_DEFAULTS.API_KEY_PEPPER);
  });

  it("production with all three defaults throws and names every offending variable", () => {
    expect(() => parseConfig(prod)).toThrow(/FORGE_MASTER_KEY, SESSION_SECRET, API_KEY_PEPPER/);
  });

  it("production names only the variable still at its default", () => {
    let message = "";
    try {
      parseConfig({ ...prod, ...strong, SESSION_SECRET: DEV_SECRET_DEFAULTS.SESSION_SECRET });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("FORGE_MASTER_KEY");
    expect(message).not.toContain("API_KEY_PEPPER");
  });

  it("production with unique secrets passes", () => {
    const config = parseConfig({ ...prod, ...strong });
    expect(config.NODE_ENV).toBe("production");
    expect(config.SESSION_SECRET).toBe(strong.SESSION_SECRET);
  });

  it("existing production SSO rule still applies", () => {
    expect(() => parseConfig({ ...base, ...strong, NODE_ENV: "production", SSO_MODE: "optional" })).toThrow(/SSO_MODE=required/);
  });
});
