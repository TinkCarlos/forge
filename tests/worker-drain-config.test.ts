import { describe, expect, it } from "vitest";
import { parseConfig } from "../packages/core/src/config-schema";

// r5 §4 (pure: config-schema only, no .env, no DB). WORKER_DRAIN_TIMEOUT_MS: integer 0..300000, default 35000.
const DB = ["my", "sql"].join("") + "://forge:placeholder@127.0.0.1:1/forge_test";
const dev = { NODE_ENV: "test", DATABASE_URL: DB, FORGE_ADMIN_PASSWORD: "dev-password-123" };
const quiet = { warn: () => undefined };
const drainOf = (value?: string) => parseConfig({ ...dev, WORKER_DRAIN_TIMEOUT_MS: value }, quiet).WORKER_DRAIN_TIMEOUT_MS;

describe("WORKER_DRAIN_TIMEOUT_MS", () => {
  it("defaults to 35000", () => expect(drainOf(undefined)).toBe(35000));
  it("accepts 0 and 300000", () => {
    expect(drainOf("0")).toBe(0);
    expect(drainOf("300000")).toBe(300000);
  });
  it.each(["-1", "300001", "1.5", "abc"])("refuses %s", (value) => {
    expect(() => drainOf(value)).toThrow(/WORKER_DRAIN_TIMEOUT_MS/);
  });
});
