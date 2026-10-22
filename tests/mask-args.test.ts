import { describe, expect, it } from "vitest";
import { buildArgsPreview } from "../packages/governance/src/args-preview.js";
import { MASK_ARGS_MAX_DEPTH, maskArgsDeep } from "../packages/governance/src/mask-args.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

describe("maskArgsDeep: same rules as args_preview, structure kept", () => {
  it("sensitive keys (segment match) at any depth -> ***; other keys/values untouched", () => {
    const input = { to: "a@b.com", api_key: "k1", nested: { accessToken: "t1", "X-Api-Key": "k2", DB_PWD: "p", keyword: "keep", monkey: 1, tokenizer: "keep" }, list: [{ password: "p2" }, "plain"] };
    expect(maskArgsDeep(input)).toEqual({
      to: "a@b.com",
      api_key: "***",
      nested: { accessToken: "***", "X-Api-Key": "***", DB_PWD: "***", keyword: "keep", monkey: 1, tokenizer: "keep" },
      list: [{ password: "***" }, "plain"],
    });
  });

  it("a sensitive key masks its whole value, even an object or array; null stays null", () => {
    expect(maskArgsDeep({ credentials: { user: "u", pass: "p" }, cookies: ["a", "b"], token: null })).toEqual({ credentials: "***", cookies: "***", token: null });
  });

  it("secret-looking values under innocent keys -> ***", () => {
    expect(maskArgsDeep({ h: "Bearer abc", b: "basic xyz", s: "SK-123", g: "ghp_abc", x: "xoxb-1", j: JWT, arr: [" Bearer q"] })).toEqual({ h: "***", b: "***", s: "***", g: "***", x: "***", j: "***", arr: ["***"] });
  });

  it("URL query secrets masked like args_preview", () => {
    expect(maskArgsDeep({ u: "https://h.test/cb?id=1&token=abc&sig=zz#frag", p: "/cb?token=x", t: "明天开会?" })).toEqual({ u: "https://h.test/cb?id=1&token=***&sig=***#frag", p: "/cb?***", t: "明天开会?" });
  });

  it("embedded JSON strings stay strings, re-serialised with masked values; broken JSON-like -> ***", () => {
    const out = maskArgsDeep({ body: JSON.stringify({ password: "x", user: "u", inner: JSON.stringify({ token: "t" }) }), broken: '{ "password":"x"', single: "{'token': 'x'}", text: "[草稿] 周报" }) as Record<string, string>;
    expect(JSON.parse(out.body!)).toEqual({ password: "***", user: "u", inner: JSON.stringify({ token: "***" }) });
    expect(out.broken).toBe("***");
    expect(out.single).toBe("***");
    expect(out.text).toBe("[草稿] 周报");
  });

  it("embedded JSON without secrets is returned byte-for-byte", () => {
    const body = '{ "a": 1,  "b": [1, 2] }';
    expect(maskArgsDeep({ body })).toEqual({ body });
  });

  it("no truncation: long values and many keys kept in full", () => {
    const long = "z".repeat(5000);
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, long]));
    expect(maskArgsDeep(many)).toEqual(many);
  });

  it("scalars, null and arrays at the top level", () => {
    expect(maskArgsDeep(null)).toBeNull();
    expect(maskArgsDeep(undefined)).toBeUndefined();
    expect(maskArgsDeep(42)).toBe(42);
    expect(maskArgsDeep(true)).toBe(true);
    expect(maskArgsDeep("Bearer x")).toBe("***");
    expect(maskArgsDeep("hello")).toBe("hello");
    expect(maskArgsDeep([{ secret: 1 }, 2])).toEqual([{ secret: "***" }, 2]);
  });

  it("does not mutate the input", () => {
    const input = { password: "p", nested: { token: "t" } };
    const copy = structuredClone(input);
    maskArgsDeep(input);
    expect(input).toEqual(copy);
  });

  it("circular references -> *** (no throw); shared non-circular references are kept", () => {
    const a: Record<string, unknown> = { name: "a", password: "p" };
    a.self = a;
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(maskArgsDeep(a)).toEqual({ name: "a", password: "***", self: "***" });
    expect(maskArgsDeep(arr)).toEqual([1, "***"]);
    const shared = { x: 1 };
    expect(maskArgsDeep({ p: shared, q: shared })).toEqual({ p: { x: 1 }, q: { x: 1 } });
  });

  it("deeper than the limit -> that subtree becomes ***; very deep input does not overflow the stack", () => {
    let deep: Record<string, unknown> = { leaf: "Bearer x" };
    for (let i = 0; i < 100_000; i += 1) deep = { d: deep };
    let out = maskArgsDeep(deep) as Record<string, unknown>;
    let level = 0;
    while (out && typeof out === "object") { out = out.d as Record<string, unknown>; level += 1; }
    expect(out).toBe("***");
    expect(level).toBe(MASK_ARGS_MAX_DEPTH);
    const shallow = { a: { b: { c: "ok" } } };
    expect(maskArgsDeep(shallow)).toEqual(shallow);
  });

  it("deeply nested embedded JSON is also bounded", () => {
    const text = `${"[".repeat(5000)}"x"${"]".repeat(5000)}`;
    expect(() => maskArgsDeep({ body: text })).not.toThrow();
    expect(JSON.stringify(maskArgsDeep({ body: text }))).toContain("***");
  });

  it("Date values pass through unchanged", () => {
    const at = new Date("2026-10-22T00:00:00Z");
    expect(maskArgsDeep({ at })).toEqual({ at });
  });

  it("agrees with buildArgsPreview on what is a secret", () => {
    const args = { to: "a@b.com", api_key: "k", url: "https://x.test/?key=1", body: '{"pwd":"p"}', h: "Bearer z" };
    const masked = maskArgsDeep(args) as Record<string, string>;
    expect(buildArgsPreview(args)).toBe("to=a@b.com, api_key=***, url=https://x.test/?key=***, body={pwd=***}, h=***");
    expect(masked).toEqual({ to: "a@b.com", api_key: "***", url: "https://x.test/?key=***", body: '{"pwd":"***"}', h: "***" });
  });
});
