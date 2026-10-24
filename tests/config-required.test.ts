import { describe, expect, it } from "vitest";
// Import the pure schema module directly: no dotenv, no process.env, no database, no module side effects.
import { DEV_SECRET_DEFAULTS, isDevLike, parseConfig } from "../packages/core/src/config-schema";

// K-21 (OPS-001): DATABASE_URL has no default in any environment.
// K-22 (OPS-002): dev secret defaults only for an explicit NODE_ENV=development|test (with a warning);
// NODE_ENV unset or production refuses missing secrets. Errors name variables only, never values.
const DB = "mysql://forge:placeholder@127.0.0.1:1/forge_test";
const admin = { FORGE_ADMIN_PASSWORD: "test-only-password-123" };
const secrets = {
  FORGE_MASTER_KEY: "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMtISE=",
  SESSION_SECRET: "test-only-session-secret-unique-32+",
  API_KEY_PEPPER: "test-only-api-key-pepper-unique-32+",
};
const SECRET_NAMES = ["FORGE_MASTER_KEY", "SESSION_SECRET", "API_KEY_PEPPER"] as const;

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

function collectWarn() {
  const messages: string[] = [];
  return { messages, warn: (message: string) => void messages.push(message) };
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
      const message = errorOf(() => parseConfig({ ...admin, ...env }, { warn: () => undefined }));
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toMatch(/mysql:\/\//i);
      expect(message).not.toMatch(/@127\.0\.0\.1|:3306/);
    });
    it(`NODE_ENV ${label}: empty / blank DATABASE_URL -> same error`, () => {
      for (const blank of ["", "   "]) {
        const message = errorOf(() => parseConfig({ ...admin, ...env, DATABASE_URL: blank }, { warn: () => undefined }));
        expect(message).toContain("DATABASE_URL");
        expect(message).not.toMatch(/mysql:\/\//i);
      }
    });
  }
  it("an explicit DATABASE_URL is used as-is", () => {
    expect(parseConfig({ ...admin, ...secrets, NODE_ENV: "test", DATABASE_URL: DB }).DATABASE_URL).toBe(DB);
  });
});

describe("K-22: secrets outside an explicit development/test NODE_ENV", () => {
  it("NODE_ENV unset + all secrets missing -> refuses, names all three, no values", () => {
    const message = errorOf(() => parseConfig({ ...admin, DATABASE_URL: DB }));
    expect(message).toContain("NODE_ENV unset");
    expect(message).toContain("FORGE_MASTER_KEY, SESSION_SECRET, API_KEY_PEPPER");
    for (const value of Object.values(DEV_SECRET_DEFAULTS)) expect(message).not.toContain(value);
  });
  it("NODE_ENV unset + one secret missing -> names only that one", () => {
    const message = errorOf(() => parseConfig({ ...admin, DATABASE_URL: DB, ...secrets, SESSION_SECRET: "" }));
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("FORGE_MASTER_KEY");
    expect(message).not.toContain("API_KEY_PEPPER");
  });
  it("NODE_ENV unset + secret explicitly equal to the dev default -> refuses", () => {
    const message = errorOf(() => parseConfig({ ...admin, DATABASE_URL: DB, ...secrets, API_KEY_PEPPER: DEV_SECRET_DEFAULTS.API_KEY_PEPPER }));
    expect(message).toContain("API_KEY_PEPPER");
    expect(message).not.toContain(DEV_SECRET_DEFAULTS.API_KEY_PEPPER);
  });
  it("NODE_ENV=production + missing secrets -> refuses", () => {
    const message = errorOf(() => parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: "production", SSO_MODE: "required" }));
    expect(message).toContain("FORGE_MASTER_KEY, SESSION_SECRET, API_KEY_PEPPER");
  });
  it("NODE_ENV=staging (not explicitly dev/test) + missing secrets -> refuses", () => {
    expect(() => parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: "staging" }, { warn: () => undefined })).toThrow(/FORGE_MASTER_KEY/);
  });
  it("NODE_ENV unset + all secrets set -> ok, no warning", () => {
    const { messages, warn } = collectWarn();
    const config = parseConfig({ ...admin, DATABASE_URL: DB, ...secrets, SSO_MODE: "required" }, { warn });
    expect(config.SESSION_SECRET).toBe(secrets.SESSION_SECRET);
    expect(config.NODE_ENV).toBeUndefined();
    expect(messages).toEqual([]);
  });
  it("production + all secrets set -> ok", () => {
    const config = parseConfig({ ...admin, DATABASE_URL: DB, ...secrets, NODE_ENV: "production", SSO_MODE: "required" });
    expect(config.NODE_ENV).toBe("production");
  });
});

describe("K-22: explicit development/test may use dev defaults, with a warning", () => {
  for (const nodeEnv of ["development", "test"]) {
    it(`NODE_ENV=${nodeEnv} + missing secrets -> ok, defaults filled, warn names variables only`, () => {
      const { messages, warn } = collectWarn();
      const config = parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: nodeEnv }, { warn });
      for (const name of SECRET_NAMES) expect(config[name]).toBe(DEV_SECRET_DEFAULTS[name]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("FORGE_MASTER_KEY, SESSION_SECRET, API_KEY_PEPPER");
      expect(messages[0]).toContain(`NODE_ENV=${nodeEnv}`);
      for (const value of Object.values(DEV_SECRET_DEFAULTS)) expect(messages[0]).not.toContain(value);
    });
    it(`NODE_ENV=${nodeEnv} + only one missing -> warn names only that one`, () => {
      const { messages, warn } = collectWarn();
      const config = parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: nodeEnv, ...secrets, SESSION_SECRET: undefined }, { warn });
      expect(config.SESSION_SECRET).toBe(DEV_SECRET_DEFAULTS.SESSION_SECRET);
      expect(config.API_KEY_PEPPER).toBe(secrets.API_KEY_PEPPER);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("SESSION_SECRET");
      expect(messages[0]).not.toContain("API_KEY_PEPPER");
    });
    it(`NODE_ENV=${nodeEnv} + all secrets set -> no warning`, () => {
      const { messages, warn } = collectWarn();
      parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: nodeEnv, ...secrets }, { warn });
      expect(messages).toEqual([]);
    });
  }
  it("HOST default is unchanged (OPS-021 pending)", () => {
    expect(parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: "test" }, { warn: () => undefined }).HOST).toBe("0.0.0.0");
  });
});

describe("K-22: isDevLike (raw NODE_ENV)", () => {
  it("true only for explicit development / test", () => {
    expect(isDevLike({ NODE_ENV: "development" })).toBe(true);
    expect(isDevLike({ NODE_ENV: "test" })).toBe(true);
    expect(isDevLike({ NODE_ENV: " development " })).toBe(true);
    for (const value of [undefined, "", "  ", "production", "staging", "dev", "Development", "TEST"]) expect(isDevLike({ NODE_ENV: value })).toBe(false);
    expect(isDevLike({})).toBe(false);
  });
});

describe("K-22 call site: SSO enforcement in parseConfig", () => {
  const ok = { ...admin, DATABASE_URL: DB, ...secrets };
  it("explicit production + SSO_MODE optional -> refused (unchanged)", () => {
    expect(() => parseConfig({ ...ok, NODE_ENV: "production", SSO_MODE: "optional" })).toThrow(/SSO_MODE=required/);
  });
  it("explicit production + SSO_MODE default -> refused (unchanged)", () => {
    expect(() => parseConfig({ ...ok, NODE_ENV: "production" })).toThrow(/SSO_MODE=required/);
  });
  it("NODE_ENV unset + SSO_MODE optional/disabled/default -> refused", () => {
    for (const mode of ["optional", "disabled", undefined]) {
      expect(() => parseConfig({ ...ok, SSO_MODE: mode })).toThrow(/SSO_MODE=required.*NODE_ENV unset/);
    }
  });
  it("NODE_ENV=staging + SSO_MODE optional -> refused", () => {
    expect(() => parseConfig({ ...ok, NODE_ENV: "staging", SSO_MODE: "optional" }, { warn: () => undefined })).toThrow(/SSO_MODE=required/);
  });
  it("NODE_ENV unset/production + SSO_MODE required -> ok", () => {
    expect(parseConfig({ ...ok, SSO_MODE: "required" }).SSO_MODE).toBe("required");
    expect(parseConfig({ ...ok, NODE_ENV: "production", SSO_MODE: "required" }).SSO_MODE).toBe("required");
  });
  it("explicit development/test + SSO_MODE optional -> ok", () => {
    for (const nodeEnv of ["development", "test"]) {
      expect(parseConfig({ ...ok, NODE_ENV: nodeEnv, SSO_MODE: "optional" }).SSO_MODE).toBe("optional");
    }
  });
});

describe("K-22: unrecognized NODE_ENV warning", () => {
  const ok = { ...admin, DATABASE_URL: DB, ...secrets, SSO_MODE: "required" };
  for (const value of ["Development", "staging", "TEST", "prod"]) {
    it(`NODE_ENV=${value} -> one warn naming the variable and value, treated as production`, () => {
      const { messages, warn } = collectWarn();
      const config = parseConfig({ ...ok, NODE_ENV: value }, { warn });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(`unrecognized NODE_ENV="${value}"`);
      expect(messages[0]).toContain("treated as production");
      for (const secret of Object.values(secrets)) expect(messages[0]).not.toContain(secret);
      expect(isDevLike(config)).toBe(false);
    });
  }
  it("unrecognized NODE_ENV still refuses missing secrets / non-required SSO", () => {
    const { warn } = collectWarn();
    expect(() => parseConfig({ ...admin, DATABASE_URL: DB, NODE_ENV: "staging" }, { warn })).toThrow(/FORGE_MASTER_KEY/);
    expect(() => parseConfig({ ...ok, NODE_ENV: "Development", SSO_MODE: "optional" }, { warn })).toThrow(/SSO_MODE=required/);
  });
  it("whitespace is trimmed first: ' production ' is recognised (no warn)", () => {
    const { messages, warn } = collectWarn();
    parseConfig({ ...ok, NODE_ENV: " production " }, { warn });
    expect(messages).toEqual([]);
  });
  for (const value of ["development", "test", "production", undefined, ""]) {
    it(`NODE_ENV=${JSON.stringify(value)} -> no unrecognized warning`, () => {
      const { messages, warn } = collectWarn();
      parseConfig({ ...ok, NODE_ENV: value }, { warn });
      expect(messages.filter((m) => m.includes("unrecognized"))).toEqual([]);
    });
  }
  it("a very long value is truncated in the warning", () => {
    const { messages, warn } = collectWarn();
    parseConfig({ ...ok, NODE_ENV: "x".repeat(500) }, { warn });
    expect(messages[0]!.length).toBeLessThan(200);
  });
});
