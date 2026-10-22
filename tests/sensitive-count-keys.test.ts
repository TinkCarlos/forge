import { describe, expect, it } from "vitest";
import { buildArgsPreview } from "../packages/governance/src/args-preview.js";
import { maskArgsDeep } from "../packages/governance/src/mask-args.js";
import { isSensitiveKey } from "../packages/governance/src/sensitive.js";

// Counter keys (token/tokens + a counting word such as max/total/count/limit) are not credentials and are not masked
// by key. Their values are still checked: a secret-looking value (Bearer/sk-/JWT) is masked whatever the key.
const COUNTER_KEYS = [
  "max_tokens", "maxTokens", "max_output_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "tokenCount",
  "token_limit", "min_tokens", "input_tokens", "outputTokens", "num_tokens", "used_tokens", "remainingTokens",
  "reasoning_tokens", "cached_tokens", "MAX_TOKENS", "max-tokens",
];
const CREDENTIAL_KEYS = ["token", "access_token", "refresh_token", "id_token", "api_token", "tokens", "authToken", "Tokens", "token2", "accessToken"];
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

describe("counter keys are not sensitive", () => {
  it.each(COUNTER_KEYS)("%s -> not sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it.each(CREDENTIAL_KEYS)("%s -> still sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it("other sensitive segments next to a counting word stay sensitive", () => {
    for (const key of ["max_api_key", "password_count", "passwords_reset_count", "secret_limit", "total_credentials", "cookie_count"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("maskArgsDeep keeps counter values and still masks secret-looking values under counter keys", () => {
    expect(maskArgsDeep({ model: "m", max_tokens: 1024, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, token: "t", access_token: "a" }))
      .toEqual({ model: "m", max_tokens: 1024, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, token: "***", access_token: "***" });
    expect(maskArgsDeep({ max_tokens: "Bearer abc", tokenCount: "sk-123", token_limit: JWT, total_tokens: "42" }))
      .toEqual({ max_tokens: "***", tokenCount: "***", token_limit: "***", total_tokens: "42" });
  });

  it("args_preview applies the same rule", () => {
    expect(buildArgsPreview({ max_tokens: 1024, tokenCount: 3, refresh_token: "r", id_token: "i", max_output_tokens: "Bearer x" }))
      .toBe("max_tokens=1024, tokenCount=3, refresh_token=***, id_token=***, max_output_tokens=***");
  });
});
