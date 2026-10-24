import { describe, expect, it } from "vitest";
import { parseConfig } from "../packages/core/src/config-schema";

// OPS-003 (P1-15): empty or too-short secrets refuse startup outside development/test; FORGE_MASTER_KEY must be a
// base64 AES-256 key (32 bytes) in every environment. OPS-007 (P1-15): production refuses the .env.example admin
// password. OPS-006 (P2-07): PORT must be 1..65535, HOST must be a valid IP or hostname (default unchanged, 0.0.0.0).
// Every error names the variable only, never its value.
const DB = "mysql://forge:placeholder@127.0.0.1:1/forge_test";
const MASTER = "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtISE="; // 32 bytes
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
const quiet = { warn: () => undefined };

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseConfig(env, quiet);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}
function expectNamesOnly(message: string, name: string, value: string) {
  expect(message).toContain(name);
  if (value.length >= 3) expect(message).not.toContain(value);
}

describe("baseline", () => {
  it("valid production config parses; HOST default stays 0.0.0.0", () => {
    const config = parseConfig(prod, quiet);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(3000);
  });
});

describe("OPS-003 secrets outside development/test", () => {
  for (const name of ["SESSION_SECRET", "API_KEY_PEPPER"] as const) {
    it(`${name} shorter than 32 characters -> refused, names only`, () => {
      const value = "short-but-not-empty-secret-31ch!".slice(0, 31);
      expectNamesOnly(errorOf({ ...prod, [name]: value }), name, value);
    });
    it(`${name} whitespace only -> refused`, () => {
      expect(errorOf({ ...prod, [name]: "     " })).toContain(name);
    });
    it(`${name} empty string -> refused`, () => {
      expect(errorOf({ ...prod, [name]: "" })).toContain(name);
    });
  }
  it("NODE_ENV unset follows the production rules", () => {
    const { NODE_ENV: _omit, ...unset } = prod;
    expect(errorOf({ ...unset, SESSION_SECRET: "x".repeat(10) })).toContain("SESSION_SECRET");
  });
});

describe("OPS-003 FORGE_MASTER_KEY must be a 32-byte base64 key in every environment", () => {
  const bad = ["c2hvcnQta2V5", "not base64 at all !!", Buffer.alloc(16, 1).toString("base64"), Buffer.alloc(33, 1).toString("base64")];
  for (const value of bad) {
    it(`production rejects ${value.length}-char key, names only`, () => {
      expectNamesOnly(errorOf({ ...prod, FORGE_MASTER_KEY: value }), "FORGE_MASTER_KEY", value);
    });
    it(`development rejects an explicitly set bad key (${value.length} chars)`, () => {
      expectNamesOnly(errorOf({ ...dev, FORGE_MASTER_KEY: value }), "FORGE_MASTER_KEY", value);
    });
  }
  it("development without a key still uses the dev default", () => {
    expect(parseConfig(dev, quiet).FORGE_MASTER_KEY).toBeTruthy();
  });
});

describe("OPS-007 production refuses the example admin password", () => {
  it("FORGE_ADMIN_PASSWORD=change-me-now in production -> refused, names only", () => {
    expectNamesOnly(errorOf({ ...prod, FORGE_ADMIN_PASSWORD: "change-me-now" }), "FORGE_ADMIN_PASSWORD", "change-me-now");
  });
  it("surrounding whitespace does not bypass the check", () => {
    expect(errorOf({ ...prod, FORGE_ADMIN_PASSWORD: " change-me-now " })).toContain("FORGE_ADMIN_PASSWORD");
  });
  it("development may still use it", () => {
    expect(() => parseConfig({ ...dev, FORGE_ADMIN_PASSWORD: "change-me-now" }, quiet)).not.toThrow();
  });
});

describe("OPS-006 PORT and HOST", () => {
  for (const value of ["0", "70000", "65536", "abc", "-1", "3000.5", "80 80"]) {
    it(`PORT=${value} -> refused, names only`, () => {
      expectNamesOnly(errorOf({ ...prod, PORT: value }), "PORT", value);
    });
  }
  for (const value of ["1", "3100", "65535"]) {
    it(`PORT=${value} accepted`, () => expect(parseConfig({ ...prod, PORT: value }, quiet).PORT).toBe(Number(value)));
  }
  for (const value of ["0.0.0.0", "127.0.0.1", "::", "::1", "fe80::1", "localhost", "api.internal", "my-host-01"]) {
    it(`HOST=${value} accepted`, () => expect(parseConfig({ ...prod, HOST: value }, quiet).HOST).toBe(value));
  }
  for (const value of ["", "   ", "256.1.1.1", "host name", "http://127.0.0.1", "127.0.0.1:3000", "-bad.example", "a..b", "x".repeat(254)]) {
    it(`HOST=${JSON.stringify(value.slice(0, 20))} -> refused, names only`, () => {
      expectNamesOnly(errorOf({ ...prod, HOST: value }), "HOST", value.trim());
    });
  }
});
