import { describe, expect, it } from "vitest";
import { DEV_SECRET_DEFAULTS, parseConfig } from "../packages/core/src/config-schema";

// P3-18 (architect ruling 4): a secret that is only whitespace counts as unset, so no environment can run with an
// empty key. Outside development/test the existing rules apply (startup refused, names only). In development/test a
// secret with a development default falls back to it with a warning naming the variable; one without a default
// (FORGE_ADMIN_PASSWORD) refuses startup naming the variable. Optional secrets (OIDC / connector client secret) that
// are only whitespace are treated exactly like unset ones.
const DB = ["mysql", "//forge:placeholder@127.0.0.1:1/forge_test"].join(":"); // placeholder, never connected
const MASTER = "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtISE=";
const prod = {
  NODE_ENV: "production",
  SSO_MODE: "required",
  DATABASE_URL: DB,
  FORGE_ADMIN_PASSWORD: "prod-unique-admin-password-xyz",
  FORGE_MASTER_KEY: MASTER,
  SESSION_SECRET: "s".repeat(31) + "S",
  API_KEY_PEPPER: "p".repeat(31) + "P",
};
const dev = { NODE_ENV: "development", DATABASE_URL: DB, FORGE_ADMIN_PASSWORD: "dev-password-123" };
const BLANKS = ["   ", "\t", " \n "];

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseConfig(env, { warn: () => undefined });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

describe("P3-18 whitespace-only secrets count as unset", () => {
  for (const nodeEnv of ["development", "test"]) {
    for (const name of ["FORGE_MASTER_KEY", "SESSION_SECRET", "API_KEY_PEPPER"] as const) {
      for (const blank of BLANKS) {
        it(`${nodeEnv}: ${name}=${JSON.stringify(blank)} -> development default + warning naming it`, () => {
          const warnings: string[] = [];
          const config = parseConfig({ ...dev, NODE_ENV: nodeEnv, [name]: blank }, { warn: (m) => warnings.push(m) });
          expect(config[name]).toBe(DEV_SECRET_DEFAULTS[name]);
          expect(warnings.join("\n")).toContain(name);
        });
      }
    }
    it(`${nodeEnv}: FORGE_ADMIN_PASSWORD whitespace only (no default) -> startup refused naming it`, () => {
      expect(errorOf({ ...dev, NODE_ENV: nodeEnv, FORGE_ADMIN_PASSWORD: "          " })).toContain("FORGE_ADMIN_PASSWORD");
    });
  }

  for (const name of ["FORGE_MASTER_KEY", "SESSION_SECRET", "API_KEY_PEPPER", "FORGE_ADMIN_PASSWORD"] as const) {
    it(`production: ${name} whitespace only -> startup refused naming it`, () => {
      expect(errorOf({ ...prod, [name]: "          " })).toContain(name);
    });
  }
  it("NODE_ENV unset: whitespace-only FORGE_MASTER_KEY refused (production rules)", () => {
    const { NODE_ENV: _omit, ...unset } = prod;
    expect(errorOf({ ...unset, FORGE_MASTER_KEY: "   " })).toContain("FORGE_MASTER_KEY");
  });

  for (const name of ["OIDC_CLIENT_SECRET", "AGENT_CONNECTOR_CLIENT_SECRET"] as const) {
    it(`${name} whitespace only -> treated as unset`, () => {
      expect(parseConfig({ ...dev, [name]: "   " }, { warn: () => undefined })[name]).toBeUndefined();
      expect(parseConfig({ ...prod, [name]: " \t " }, { warn: () => undefined })[name]).toBeUndefined();
    });
  }

  it("non-blank secrets are kept unchanged (no trimming of real values)", () => {
    const config = parseConfig({ ...dev, SESSION_SECRET: " real-dev-secret ", OIDC_CLIENT_SECRET: "abc" }, { warn: () => undefined });
    expect(config.SESSION_SECRET).toBe(" real-dev-secret ");
    expect(config.OIDC_CLIENT_SECRET).toBe("abc");
  });
});
