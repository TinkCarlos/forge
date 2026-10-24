import { describe, expect, it } from "vitest";
import { maskArgsDeep, maskProseSecrets } from "../packages/governance/src/index";
import { presentRunOutput } from "../apps/api/src/plugins/http-helpers";

// P2: an OpenAI-style key standing alone inside prose (`sk-` followed by at least 16 key characters, one of them a
// digit) is masked by the same function as everything else (maskArgsDeep -> maskProseSecrets). Short or digit-free
// words that merely start with sk- (sk-learn, sk-ii) stay readable.
const KEY = "sk-proj-AbCdEf0123456789XyZ";

describe("P2 standalone sk- keys", () => {
  it("masks a key in the middle of a sentence (string, object, run output)", () => {
    expect(maskArgsDeep(`我的 key 是 ${KEY}，别外传`)).toBe("我的 key 是 ***，别外传");
    expect(maskArgsDeep({ text: `use ${KEY} now` })).toEqual({ text: "use *** now" });
    expect(presentRunOutput({ text: `(${KEY})` })).toEqual({ text: "(***)" });
    expect(maskProseSecrets(`a ${KEY} b ${KEY}`)).toBe("a *** b ***");
  });
  it("leaves sk-learn / short sk- words readable", () => {
    for (const text of ["用 sk-learn 做分类", "sk-ii 面霜", "task-1234567890123456789 done", "ask-abcdefghij0123456789"]) {
      expect(maskArgsDeep(`x ${text}`)).toBe(`x ${text}`);
    }
  });
});
