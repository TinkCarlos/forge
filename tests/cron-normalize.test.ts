import { describe, expect, it } from "vitest";
import { CRON_INVALID_MESSAGE, normalizeCron } from "../packages/core/src/cron.js";

// Pure: the one cron normalizer shared by schedule create / PATCH, /enable and the scheduler (imported from the source
// file, not the @forge/core index, which would parse the process config on import).
describe("normalizeCron", () => {
  it("maps the seven accepted macros to 5-field expressions", () => {
    expect(
      Object.fromEntries(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"].map((m) => [m, normalizeCron(m)])),
    ).toEqual({
      "@yearly": "0 0 1 1 *",
      "@annually": "0 0 1 1 *",
      "@monthly": "0 0 1 * *",
      "@weekly": "0 0 * * 0",
      "@daily": "0 0 * * *",
      "@midnight": "0 0 * * *",
      "@hourly": "0 * * * *",
    });
  });

  it("trims first and matches macros case-insensitively", () => {
    expect(normalizeCron("@DAILY")).toBe("0 0 * * *");
    expect(normalizeCron(" @daily ")).toBe("0 0 * * *");
    expect(normalizeCron("\t@Hourly\n")).toBe("0 * * * *");
  });

  it("@reboot and other macros are not rewritten (the 5-field check then rejects them)", () => {
    for (const m of ["@reboot", "@REBOOT", "@every 5m", "@", "@dailyx"]) expect(normalizeCron(m)).toBe(m);
    expect(normalizeCron(" @reboot ")).toBe("@reboot");
  });

  it("a plain expression is only trimmed: case and inner spacing are kept", () => {
    expect(normalizeCron(" 0 9 * * MON ")).toBe("0 9 * * MON");
    expect(normalizeCron("0  9 * * *")).toBe("0  9 * * *");
    expect(normalizeCron("*/5 * * * *")).toBe("*/5 * * * *");
  });

  it("400 message names the accepted forms", () => {
    expect(CRON_INVALID_MESSAGE).toBe("只支持 5 段 cron 或 @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly");
  });
});
