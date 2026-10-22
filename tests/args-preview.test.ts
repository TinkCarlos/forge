import { describe, expect, it } from "vitest";
import { ARGS_PREVIEW_TOTAL_MAX, ARGS_PREVIEW_VALUE_MAX, buildArgsPreview } from "../packages/governance/src/args-preview.js";

describe("buildArgsPreview", () => {
  it("null/undefined args -> null", () => {
    expect(buildArgsPreview(null)).toBeNull();
    expect(buildArgsPreview(undefined)).toBeNull();
  });

  it("renders key=value pairs and masks sensitive keys case-insensitively", () => {
    const preview = buildArgsPreview({ to: "a@b.com", Password: "hunter2", apiKey: "sk-live-1", Authorization: "Bearer abc", refresh_token: "rt", clientSecret: { v: 1 }, count: 3, ok: true, none: null });
    expect(preview).toBe("to=a@b.com, Password=***, apiKey=***, Authorization=***, refresh_token=***, clientSecret=***, count=3, ok=true, none=null");
    for (const raw of ["hunter2", "sk-live-1", "Bearer abc", "rt,"]) expect(preview).not.toContain(raw);
  });

  it("masks recursively in nested objects and arrays", () => {
    const preview = buildArgsPreview({ conn: { host: "db", auth: { password: "p@ss", user: "u" } }, items: [{ token: "t1", id: 1 }, "x"] })!;
    expect(preview).toBe("conn={host=db, auth={password=***, user=u}}, items=[{token=***, id=1}, x]");
    expect(preview).not.toContain("p@ss");
    expect(preview).not.toContain("t1");
  });

  it("truncates each value to 80 chars", () => {
    const preview = buildArgsPreview({ body: "a".repeat(200) })!;
    const value = preview.slice("body=".length);
    expect(Array.from(value)).toHaveLength(ARGS_PREVIEW_VALUE_MAX);
    expect(value.endsWith("…")).toBe(true);
    expect(buildArgsPreview({ body: "b".repeat(80) })).toBe(`body=${"b".repeat(80)}`);
  });

  it("caps the whole preview at 300 chars", () => {
    const args = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, "x".repeat(70)]));
    const preview = buildArgsPreview(args)!;
    expect(Array.from(preview)).toHaveLength(ARGS_PREVIEW_TOTAL_MAX);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("handles non-object args and deep nesting", () => {
    expect(buildArgsPreview("plain")).toBe("plain");
    expect(buildArgsPreview([1, 2])).toBe("[1, 2]");
    expect(buildArgsPreview({})).toBe("");
    expect(buildArgsPreview({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toBe("a={b={c={d={e={…}}}}}");
  });
});
