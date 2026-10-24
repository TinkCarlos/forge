import { describe, expect, it, vi } from "vitest";

// Pure (no DB, no .env): @forge/core would parse the process config on import, so only its error factory is stubbed.
const { ForgeError } = vi.hoisted(() => ({
  ForgeError: class ForgeError extends Error {
    constructor(public readonly code: string, message: string, public readonly httpStatus = 400, public readonly details?: unknown) {
      super(message);
    }
  },
}));
type ForgeError = InstanceType<typeof ForgeError>;
vi.mock("@forge/core", () => ({
  ForgeError,
  errors: { invalid: (m: string, details?: unknown) => new ForgeError("CFG-8501", m, 400, details) },
}));
import {
  agentFieldsSchema,
  approvalDecideSchema,
  assertScheduleTiming,
  limitQuerySchema,
  parseInput,
  schedulePatchSchema,
  userCreateSchema,
} from "../apps/api/src/plugins/input-schema.js";

function invalid(fn: () => unknown): { code: string; status: number; message: string; field?: string } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    const e = error as ForgeError;
    return { code: e.code, status: e.httpStatus, message: e.message, field: (e.details as { field?: string } | undefined)?.field };
  }
  throw new Error("expected a validation error");
}

describe("route input schemas (400 CFG-8501, before any DB access)", () => {
  it("K-23: agent name over 128 / description over 1024 -> 400; 128 is fine", () => {
    expect(invalid(() => parseInput(agentFieldsSchema, { name: "a".repeat(200) }))).toMatchObject({ code: "CFG-8501", status: 400, field: "name" });
    expect(invalid(() => parseInput(agentFieldsSchema, { description: "d".repeat(1025) }))).toMatchObject({ code: "CFG-8501", field: "description" });
    expect(invalid(() => parseInput(agentFieldsSchema, { name: 42 }))).toMatchObject({ code: "CFG-8501", field: "name" });
    expect(parseInput(agentFieldsSchema, { name: "a".repeat(128), key: "k" })).toMatchObject({ key: "k" });
  });

  it("I-USR-02: missing email / email=abc -> 400; over-long username -> 400", () => {
    expect(invalid(() => parseInput(userCreateSchema, {}))).toMatchObject({ code: "CFG-8501", field: "email" });
    expect(invalid(() => parseInput(userCreateSchema, { email: "abc" }))).toMatchObject({ code: "CFG-8501", field: "email", message: "email 格式无效" });
    expect(invalid(() => parseInput(userCreateSchema, { email: "a@b.co", username: "u".repeat(65) }))).toMatchObject({ field: "username" });
    expect(parseInput(userCreateSchema, { email: " a@forge.local " }).email).toBe("a@forge.local");
  });

  it("I-APR-34: missing decision / comment of 1025 chars -> 400 CFG-8501; 1024 is fine", () => {
    expect(invalid(() => parseInput(approvalDecideSchema, {}))).toMatchObject({ code: "CFG-8501", field: "decision" });
    expect(invalid(() => parseInput(approvalDecideSchema, { decision: "approved", comment: "c".repeat(1025) }))).toMatchObject({ code: "CFG-8501", field: "comment" });
    expect(parseInput(approvalDecideSchema, { decision: "rejected", comment: "c".repeat(1024) }).decision).toBe("rejected");
  });

  it("I-RUN-02 / S-25: limit=abc/1.5/-1/0/1e2 -> 400; absent or a positive integer passes", () => {
    const schema = limitQuerySchema(500);
    for (const limit of ["abc", "1.5", "-1", "0", "1e2", "", "501", 1.5]) {
      expect(invalid(() => parseInput(schema, { limit }))).toMatchObject({ code: "CFG-8501", status: 400, field: "limit" });
    }
    expect(parseInput(schema, {}).limit).toBeUndefined();
    expect(parseInput(schema, { limit: "20" }).limit).toBe(20);
    expect(parseInput(schema, { limit: 500 }).limit).toBe(500);
  });

  it("K-24 / I-ERR-22 / I-SCH-04: invalid cron or status -> 400; invalid timezone says timezone, not cron", () => {
    expect(invalid(() => parseInput(schedulePatchSchema, { status: "paused" }))).toMatchObject({ code: "CFG-8501", field: "status" });
    expect(invalid(() => parseInput(schedulePatchSchema, { cron: 5 }))).toMatchObject({ field: "cron" });
    expect(invalid(() => assertScheduleTiming("not a cron", "Asia/Shanghai"))).toMatchObject({ code: "CFG-8501", field: "cron", message: "Cron 表达式无效" });
    expect(invalid(() => assertScheduleTiming("0 9 * * *", "Mars/Olympus"))).toMatchObject({ code: "CFG-8501", field: "timezone", message: "时区无效" });
    expect(invalid(() => assertScheduleTiming("0 9 * * *", ""))).toMatchObject({ field: "timezone" });
    expect(() => assertScheduleTiming("0 9 * * *", "Asia/Shanghai")).not.toThrow();
  });
});

describe("validation lives in the route schema, not the error handler (P1-01 3)", () => {
  it("errors.ts maps no MySQL data errors to 400", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../apps/api/src/plugins/errors.ts", import.meta.url), "utf8");
    for (const code of ["ER_DATA_TOO_LONG", "ER_TRUNCATED_WRONG_VALUE", "ER_BAD_NULL_ERROR", "WARN_DATA_TRUNCATED"]) expect(src).not.toContain(code);
  });
});
