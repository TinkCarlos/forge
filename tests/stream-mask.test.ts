import { describe, expect, it } from "vitest";
import { createStreamMasker, STREAM_MASK_HOLD_MAX } from "../packages/governance/src/stream-mask";
import { maskArgsDeep } from "../packages/governance/src/mask-args";

// P1 SSE masking (architect + QA): the live message.delta stream is masked with the same function as run output
// (maskArgsDeep) applied to the accumulated text; only a stable prefix is released. The tail is held while it could
// still be the start of a credential pattern or is inside an unfinished match (no fixed length: `Bearer \S+` has no
// upper bound), until a delimiter arrives or the message completes. Hard cap 4 KiB: a held tail longer than that is
// released as `***` and the rest of that match is dropped. Never buffered by line or sentence.
type Run = { out: string[]; joined: string };
function stream(pieces: string[]): Run {
  const masker = createStreamMasker();
  const out: string[] = [];
  for (const piece of pieces) {
    const released = masker.push(piece);
    if (released) out.push(released);
  }
  const rest = masker.end();
  if (rest) out.push(rest);
  return { out, joined: out.join("") };
}
const noPartialMask = (pieces: string[]) => {
  for (const piece of pieces) {
    for (const run of piece.match(/\*+/g) ?? []) expect(run.length % 3, JSON.stringify(piece)).toBe(0);
  }
};

describe("createStreamMasker", () => {
  it("a key split across two pieces never leaks either half", () => {
    const r = stream(["hello token=Qx7Zp", "Lm42Vb ok, bye"]);
    expect(r.joined).toBe("hello token=***, bye".replace(", bye", " ok, bye").replace("token=*** ok", "token=*** ok"));
    expect(r.joined).toBe(maskArgsDeep("hello token=Qx7ZpLm42Vb ok, bye"));
    expect(r.joined).not.toMatch(/Qx7Zp|Lm42Vb/);
  });

  it("a key in the last piece is masked on completion", () => {
    const r = stream(["hello ", "api_key=Zz9Yy8Xx"]);
    expect(r.joined).toBe("hello api_key=***");
    expect(r.out[0]).toBe("hello ");
  });

  it("Chinese 密码： split inside the keyword and the value", () => {
    const r = stream(["我的密", "码：Pa55", "wOrdZ，别说", "出去"]);
    expect(r.joined).toBe("我的密码：***，别说出去");
    expect(r.joined).not.toMatch(/Pa55|wOrdZ/);
    expect(r.out.join("|")).not.toContain("Pa55");
  });

  it("the *** placeholder is never cut between two releases", () => {
    const text = "a password=x1 b token=y2 c secret=z3 d";
    const pieces = text.match(/.{1,3}/g)!;
    const r = stream(pieces);
    expect(r.joined).toBe(maskArgsDeep(text));
    noPartialMask(r.out);
  });

  it("a 200-character Bearer token cut into 3 pieces: no piece of it is released in clear", () => {
    const token = Array.from({ length: 200 }, (_, i) => "AbC9xYz1".charAt(i % 8)).join("");
    const parts = [token.slice(0, 70), token.slice(70, 140), token.slice(140)];
    const r = stream([`Authorization: Bearer ${parts[0]}`, parts[1]!, `${parts[2]} done`]);
    for (const part of parts) expect(r.joined).not.toContain(part.slice(0, 16));
    expect(r.joined).toBe("Authorization: Bearer *** done");
  });

  it("4 KiB hard cap: an unbounded token is released as *** and the rest of it is dropped", () => {
    const token = "Zq1".repeat(2000); // 6000 chars, no delimiter
    const pieces = ["start Bearer ", ...token.match(/.{1,1000}/g)!, " end"];
    const masker = createStreamMasker();
    const out: string[] = [];
    let fed = 0;
    let fedWhenReleased = -1;
    for (const piece of pieces) {
      fed += piece.length;
      out.push(masker.push(piece));
      if (fedWhenReleased === -1 && out.join("").includes("***")) fedWhenReleased = fed;
    }
    out.push(masker.end());
    const joined = out.join("");
    expect(joined).not.toContain("Zq1Zq1");
    expect(joined).toBe("start Bearer *** end");
    // the held tail is released (as ***) as soon as it passes the cap, not at the end of the message
    expect(fedWhenReleased).toBeGreaterThan(STREAM_MASK_HOLD_MAX);
    expect(fedWhenReleased).toBeLessThanOrEqual(STREAM_MASK_HOLD_MAX + 1000 + "start Bearer ".length);
  });

  it("whole-message rules: JSON text, a leading sk- key or JWT is held until complete", () => {
    expect(stream(['{"pass', 'word":"x1', '"}']).joined).toBe('{"password":"***"}');
    expect(stream(["sk-proj-", "Abc0123456789xyzQWE"]).joined).toBe("***");
  });

  it("standalone sk- key split across pieces", () => {
    const r = stream(["key sk-proj-Ab", "c0123456789xyzQWE ok"]);
    expect(r.joined).toBe("key *** ok");
  });

  it("plain text is released as it arrives (no line / sentence buffering)", () => {
    const masker = createStreamMasker();
    expect(masker.push("Forge 演示助手已收到")).toBe("Forge 演示助手已收到");
    expect(masker.push("：你好")).toBe("：你好");
    expect(masker.end()).toBe("");
  });
});

describe("createStreamMasker: any split gives the REST result", () => {
  const texts = [
    "Forge 演示助手已收到：请记住 password=Hunter2Sekret 和 Bearer abcDEF1234567890xyz 以及 sk-proj-Zz0123456789abcdefXY 还有我的密码：Pa55wOrdZ，谢谢",
    "use api-key: K3yK3yK3y; client_secret=cs-0001 then Basic dXNlcjpwYXNz ok",
    "Basic idea: tokens are counted, not the token itself. Bearer of news.",
    "看这个链接 https://api.example.com/cb?token=q-SEKRET-4&page=2 然后继续",
    "问题? 没有链接",
    '{"access_token":"tok-SEKRET-1","ok":true}',
    "  eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln  ",
    "密钥：abc123，令牌=xyz789。口令 : p@ss1",
    "😀 emoji 😀 token=😀secret1 end",
  ];
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  it.each(texts)("%s", (text) => {
    for (let round = 0; round < 200; round += 1) {
      const pieces: string[] = [];
      for (let i = 0; i < text.length; ) {
        const n = 1 + rand(9);
        pieces.push(text.slice(i, i + n));
        i += n;
      }
      const r = stream(pieces);
      expect(r.joined, JSON.stringify(pieces)).toBe(maskArgsDeep(text));
      noPartialMask(r.out);
    }
  });
});
