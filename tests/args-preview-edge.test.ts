// Edge cases for buildArgsPreview, handed over by 测试工程师 (57 cases).
// "masked": the fake secret must not appear in the preview. "kept": shown verbatim on purpose.
// "KNOWN LIMIT": documented leak in admin-api.md; asserted so any behaviour change is noticed.
import { describe, expect, it } from "vitest";
import { buildArgsPreview } from "../packages/governance/src/args-preview.js";

const F = "FAKEFAKEFAKE";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
const long = "x".repeat(70) + F;
const preview = (args: unknown) => buildArgsPreview(args) ?? "";

const masked: [string, unknown][] = [
  ["bearer lowercase", { h: `bearer ${F}` }], ["BEARER uppercase", { h: `BEARER ${F}` }], ["leading spaces before Bearer", { h: `  Bearer ${F}` }],
  ["Basic", { h: `Basic ${F}` }], ["sk-", { v: `sk-${F}` }], ["SK- uppercase", { v: `SK-${F}` }], ["ghp_", { v: `ghp_${F}` }], ["GHP_ uppercase", { v: `GHP_${F}` }],
  ["xoxb-", { v: `xoxb-${F}` }], ["XOXB- uppercase", { v: `XOXB-${F}` }], ["JWT", { v: jwt }],
  ["nested headers Authorization", { headers: { Authorization: `Bearer ${F}` } }], ["array element", { list: [`sk-${F}`] }], ["deep nested key", { a: { b: { secret: F } } }],
  ["url ?token", { url: `https://ex.com/a?token=${F}&q=1` }], ["url ?Token case", { url: `https://ex.com/a?Token=${F}` }],
  ["url duplicate token", { url: `https://ex.com/a?token=${F}&token=${F}2` }], ["url encoded access_token", { url: `https://ex.com/a?access_token=${F}%20x` }],
  ["url sig", { url: `https://ex.com/a?sig=${F}` }], ["url inside free text", { text: `see https://ex.com/?token=${F} now` }],
  ["path-like ?", { u: `/api/x?token=${F}` }], ["www-like ?", { u: `www.ex.com/a?token=${F}` }],
  ["82-char token value (mask before truncate)", { token: long }], ["82-char Bearer value", { h: `Bearer ${long}` }],
  ["API_KEY", { API_KEY: F }], ["x-api-key", { "x-api-key": F }], ["clientSecret", { clientSecret: F }], ["accessToken", { accessToken: F }],
  ["keyId", { keyId: F }], ["private_key", { private_key: F }], ["passwords", { passwords: F }], ["passwd", { passwd: F }], ["pwd", { pwd: F }],
  ["DB_PWD", { DB_PWD: F }], ["apiKeys", { apiKeys: F }], ["credentials", { credentials: F }], ["Tokens", { Tokens: F }],
  ["cookie", { cookie: F }], ["Set-Cookie", { "Set-Cookie": F }],
  ["JSON string object", { body: JSON.stringify({ password: F }) }], ["JSON string array", { body: JSON.stringify([{ token: F }]) }],
  ["JSON in JSON", { body: JSON.stringify({ inner: JSON.stringify({ password: F }) }) }], ["JSON string with Bearer value", { body: JSON.stringify({ h: `Bearer ${F}` }) }],
  ["JSON string with leading spaces", { body: `  ${JSON.stringify({ password: F })}` }],
  // Moved from knownLimits: since 0438dec a JSON-like string that does not parse is masked whole.
  ["incomplete JSON string (malformed)", { body: `{"password": "${F}"` }],
];
const kept: [string, unknown][] = [
  ["JWT-like with one dot", { v: `eyJ${F}.abc` }], ["keyword", { keyword: F }], ["monkey", { monkey: F }], ["tokenizer", { tokenizer: F }],
  ["author", { author: F }], ["cookbook", { cookbook: F }], ["secretary", { secretary: F }], ["sentence with ?", { subject: `明天开会? ${F}` }],
  ["sk- not at start", { v: `my sk-${F}` }],
];
const knownLimits: [string, unknown][] = [
  ["url fragment #token", { url: `https://ex.com/a#token=${F}` }], ["url without scheme/slash/www", { url: `ex.com/a?token=${F}` }],
  ["full-width ？", { u: `https://ex.com/a？token=${F}` }],
];

describe("args_preview edge cases: masked", () => { it.each(masked)("%s", (_n, a) => expect(preview(a)).not.toContain(F)); });
it("incomplete JSON string -> whole value ***", () => { expect(preview({ body: `{"password": "${F}"` })).toBe("body=***"); });
describe("args_preview edge cases: kept verbatim", () => { it.each(kept)("%s", (_n, a) => expect(preview(a)).toContain(F)); });
describe("args_preview KNOWN LIMITS (documented; flip when fixed)", () => { it.each(knownLimits)("%s", (_n, a) => expect(preview(a)).toContain(F)); });
it("caps the whole preview at 300 chars", () => {
  expect(preview(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v".repeat(50)]))).length).toBeLessThanOrEqual(300);
});
