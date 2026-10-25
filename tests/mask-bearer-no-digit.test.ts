import { describe, expect, it } from "vitest";
import { maskArgsDeep, maskProseSecrets } from "../packages/governance/src/index";
import { presentRunOutput } from "../apps/api/src/plugins/http-helpers";

// RED FIRST, fix not done. Covers digit-free Bearer tokens (MND-01..03) and digit-free sk- keys (MND-04/05). assistant-message-read-masking.test.ts builds its Bearer token from
// randomBytes(18).toString("base64url") (24 chars of [A-Za-z0-9_-]); when no digit is drawn the token stays in clear
// text and that test fails. This pins the failing case with a fixed, digit-free token of the same shape so it fails
// on every run. Pure: no DB, no network. The expected behaviour (a digit-free Bearer token in prose is masked) is
// what assistant-message-read-masking.test.ts asserts; the masking rules themselves are not changed here.
const TOKEN = "AbCdEfGh-IjKlMnOp_QrStUvWx";
const BEARER = `Bearer ${TOKEN}`;
// Same gap for OpenAI-style keys: PROSE_SK (sensitive.ts:68) also requires a digit. Fixed, digit-free, 36 key chars.
const SK = "sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj";

describe("digit-free Bearer token / sk- key inside prose (red first, fix not done)", () => {
  it("MND-01: the assistant text from the read-masking test hides the token (maskArgsDeep)", () => {
    const text = `好的。API key: sk-${"ab".repeat(18)}\nAuthorization: ${BEARER}\n数据库密码：pwabcdefabcdef`;
    expect(JSON.stringify(maskArgsDeep({ text }))).not.toContain(TOKEN);
  });

  it("MND-02: maskProseSecrets hides a digit-free Bearer token mid-sentence", () => {
    expect(maskProseSecrets(`call it with ${BEARER} please`)).not.toContain(TOKEN);
  });

  it("MND-04: maskProseSecrets hides a digit-free standalone sk- key mid-sentence", () => {
    expect(maskProseSecrets(`我的 key 是 ${SK}，别外传`)).not.toContain(SK);
  });

  it("MND-05: maskArgsDeep / presentRunOutput hide a digit-free sk- key in prose", () => {
    expect(JSON.stringify(maskArgsDeep({ text: `use ${SK} now` }))).not.toContain(SK);
    expect(JSON.stringify(presentRunOutput({ text: `(${SK})` }))).not.toContain(SK);
  });

  it("MND-03: run output leaving the server (presentRunOutput) hides it", () => {
    expect(JSON.stringify(presentRunOutput({ text: `Authorization: ${BEARER}` }))).not.toContain(TOKEN);
  });
});
