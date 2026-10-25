import { describe, expect, it } from "vitest";
import { buildArgsPreview, maskArgsDeep, maskProseSecrets } from "../packages/governance/src/index";
import { MASK01_KEEP, MASK01_VECTORS } from "./helpers/mask01-vectors";

// MASK-01: the prose masking rules, independent of whether a token contains a digit.
// Known prefixes: Bearer, sk-, ghp_/gho_/ghs_/ghu_/github_pat_, xox[abprs]-, AKIA/ASIA, JWT (eyJ.eyJ.x).
// Keyword key-value: the whole key before ":" / "=" must be exactly a keyword (case-insensitive), the value is masked whole.
// Not covered (P2): bare hex / base64 runs with neither a keyword nor a known prefix stay as they are.

describe("MASK-01 known prefixes and keyword key-value are masked, with or without a digit", () => {
  it.each(MASK01_VECTORS)("$name", ({ text, secret }) => {
    const prose = maskProseSecrets(text);
    expect(prose).not.toContain(secret);
    expect(prose).toContain("***");
    expect(JSON.stringify(maskArgsDeep({ text, nested: [{ note: text }] }))).not.toContain(secret);
    expect(buildArgsPreview({ note: text })).not.toContain(secret);
  });

  it("a secret value given whole (no surrounding text) is masked to ***", () => {
    for (const v of MASK01_VECTORS.filter((x) => x.name.startsWith("prefix") && !x.name.startsWith("prefix Bearer"))) {
      expect(maskArgsDeep({ value: v.secret })).toEqual({ value: "***" });
    }
  });

  it("keyword values are masked whole and the key is kept", () => {
    expect(maskProseSecrets("token: QwErTyUiOpAs (keep me)")).toBe("token: *** (keep me)");
    expect(maskProseSecrets("X-Api-Key=QwErTyUiOpAs")).toBe("X-Api-Key=***");
    expect(maskProseSecrets("use Authorization: Bearer abc")).toBe("use Authorization: ***");
    expect(maskProseSecrets("API key: sk-abababababababababab")).toBe("API key: ***");
  });
});

describe("MASK-01 false-positive guard: ordinary text stays byte-for-byte", () => {
  it.each(MASK01_KEEP)("%s", (text) => {
    expect(maskProseSecrets(text)).toBe(text);
    expect(maskArgsDeep({ text })).toEqual({ text });
  });
});
