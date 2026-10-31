import { describe, expect, it } from "vitest";
import { exitCall, expectChildExit, jsonPhases } from "./helpers/shutdown-assert.js";

// r6 A19 / QA acceptance 2: a child that hangs or never reports its exit time must fail the timing assertion, not
// skip it because a value parsed as undefined.
const phase = (name: string, phaseSeq: number) => JSON.stringify({ level: 30, phase: name, phaseSeq, ms: phaseSeq });
const exitLine = (ms: unknown, code: unknown = 0) => JSON.stringify({ level: 30, event: "exit_call", ms, code, msg: "x" });

describe("shutdown-assert helper", () => {
  it("exitCall reads the one exit_call line among other output", () => {
    const output = ["Forge API listening", phase("signal", 1), phase("exit", 2), exitLine(42, 1), ""].join("\n");
    expect(exitCall(output)).toEqual({ ms: 42, code: 1 });
  });

  it("exitCall throws with the output when the line is missing (hung or killed child)", () => {
    const output = [phase("signal", 1), "still draining"].join("\n");
    expect(() => exitCall(output)).toThrow(/got 0[\s\S]*still draining/);
  });

  it("exitCall throws when ms or code is not a number, or the line appears twice", () => {
    expect(() => exitCall(exitLine(undefined))).toThrow(/without numeric ms/);
    expect(() => exitCall(exitLine("12"))).toThrow(/without numeric ms/);
    expect(() => exitCall(exitLine(12, null))).toThrow(/without numeric ms/);
    expect(() => exitCall([exitLine(1), exitLine(2)].join("\n"))).toThrow(/got 2/);
  });

  it("expectChildExit fails above maxMs, below minMs, or on another code", () => {
    expect(() => expectChildExit(exitLine(9501, 1), { code: 1, maxMs: 9500 })).toThrow();
    expect(() => expectChildExit(exitLine(998, 1), { code: 1, maxMs: 9500, minMs: 999 })).toThrow();
    expect(() => expectChildExit(exitLine(10, 1), { code: 0, maxMs: 9500 })).toThrow();
    expect(expectChildExit(exitLine(9500, 1), { code: 1, maxMs: 9500, minMs: 999 })).toEqual({ ms: 9500, code: 1 });
  });

  it("jsonPhases sorts by phaseSeq, not by arrival", () => {
    expect(jsonPhases([phase("exit", 3), phase("signal", 1), phase("app_close", 2)].join("\n")).map((entry) => entry.phase)).toEqual(["signal", "app_close", "exit"]);
  });
});
