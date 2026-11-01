import { describe, expect, it } from "vitest";
import { credentialRedactor, ForgeError } from "@forge/core";

describe("credential redaction before persistence, errors and SSE", () => {
  it("masks literal and JSON-escaped values, regex characters, keys and error causes", () => {
    const value = 'private"\\key.*[x]$', redactor = credentialRedactor([value]);
    const input = { [value]: { nested: [value, JSON.stringify({ value })] } };
    expect(JSON.stringify(redactor.value(input))).not.toContain("private");
    const error = redactor.error(new ForgeError("MDL-3001", { message: value, details: input, headers: { x: value }, retryable: false }, new Error(value)));
    expect(error.code).toBe("MDL-3001"); expect(error.retryable).toBe(false);
    expect(error.message).toBe("***"); expect(JSON.stringify(error)).not.toContain("private");
  });
  it("never leaks a secret split at any chunk boundary and agrees with whole-text masking", () => {
    for (const secrets of [["TOKEN"], ["ab", "abc", "bcde"], ["a", "***"], ['a"b\\c']]) {
      const plain = `before ${secrets.join(" / ")} after ${JSON.stringify(secrets)}`;
      const expected = credentialRedactor(secrets).text(plain);
      for (let a = 0; a <= plain.length; a++) for (let b = a; b <= plain.length; b++) {
        const r = credentialRedactor(secrets);
        const output = r.chunk(plain.slice(0, a)) + r.chunk(plain.slice(a, b)) + r.chunk(plain.slice(b)) + r.flush();
        expect(output, `${JSON.stringify(secrets)} split ${a}/${b}`).toBe(expected);
        expect(r.flush()).toBe("");
      }
    }
  });
  it("does not mix credentials between invocations or damage text without credentials", () => {
    expect(credentialRedactor(["first-secret"]).text("first-secret second-secret")).toBe("*** second-secret");
    const r = credentialRedactor([]), error = new ForgeError("SYS-9001");
    expect(r.chunk("hello")).toBe("hello"); expect(r.flush()).toBe("");
    expect(r.error(error)).toBe(error);
    const long = "k".repeat(65536), mask = credentialRedactor([long]);
    expect(mask.chunk(long.slice(0, 10000))).toBe("");
    expect(mask.chunk(long.slice(10000)) + mask.flush()).toBe("***");
  });
  it("keeps JSON Schema protocol structure intact even for short credentials", () => {
    const r = credentialRedactor(["en", "string", "user"]);
    expect(r.schema({type:"object",properties:{payload:{type:"string",description:"user en",enum:["safe"]}},required:["payload"]})).toEqual({type:"object",properties:{payload:{type:"string",description:"*** ***",enum:["safe"]}},required:["payload"]});
    for (const spec of [{enum:["en"]},{pattern:"en"},{"x-en":"metadata"},{type:"en"}]) expect(() => r.schema(spec)).toThrow(expect.objectContaining({code:"SYS-9002"}));
  });
  it("preserves keys/numbers in structured output and tool arguments across every stream split", () => {
    const raw = '{"payload":"hello en", "limit":123,"nested":["user",true,null]}';
    const expected = '{"payload":"hello ***", "limit":123,"nested":["***",true,null]}';
    expect(credentialRedactor(["en","123","user"]).jsonText(raw)).toBe(expected);
    for(let i=0;i<=raw.length;i++) {
      const r = credentialRedactor(["en","123","user"]);
      expect(r.chunk(raw.slice(0,i)) + r.chunk(raw.slice(i)) + r.flush()).toBe(expected);
    }
    for (const render of [(r: ReturnType<typeof credentialRedactor>) => r.identifier("echo_sensitive-token"), (r: ReturnType<typeof credentialRedactor>) => r.schema({type:"object",properties:{"echo_sensitive-token":{type:"string"}}}), (r: ReturnType<typeof credentialRedactor>) => r.jsonText('{"echo_sensitive-token":"x"}')]) expect(() => render(credentialRedactor(["sensitive-token"]))).toThrow(expect.objectContaining({code:"SYS-9002"}));
    expect(credentialRedactor(["en"]).jsonText('{"content":"en"')).toBe('{"cont***t":"***"');
    expect(credentialRedactor(["private"]).jsonText('{"id":9007199254740993,"amount":1.2300,"payload":"private"}')).toBe('{"id":9007199254740993,"amount":1.2300,"payload":"***"}');
  });
  it("distinguishes schema nodes from arbitrary enum/const/extension instances and dependency maps", () => {
    const r = credentialRedactor(["opaque-private-token"]);
    for (const spec of [{type:"object",const:{type:"invoice"}}, {enum:[{type:"invoice"}]}, {dependentRequired:{type:["payload"]}}, {dependencies:{type:["payload"]}}, {"x-ui":{type:"textarea"}}]) expect(r.schema(spec)).toEqual(spec);
  });
});
