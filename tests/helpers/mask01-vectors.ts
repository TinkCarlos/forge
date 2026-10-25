// MASK-01 fixed test vectors (no random values). Every P1 class of the ruling, each once with and once without a digit.
// All values are fake. Bare hex / base64 fragments without a keyword or a known prefix are NOT covered (left for P2).

export interface MaskVector {
  /** Case name: class / variant / digit or no digit. */
  name: string;
  /** Text as it appears in an assistant message or run output. */
  text: string;
  /** The part that must never appear in a read response. */
  secret: string;
}

const ND = "AbCdEfGhIjKlMnOpQrStUvWx"; // 24 chars, no digit
const WD = "AbCd3fGhIjKlMn0pQrStUvW7"; // 24 chars, with digits

const prefixed: Array<[string, (body: string) => string, (secret: string) => string]> = [
  ["Bearer", (b) => `Bearer ${b.slice(0, 12)}-._~+/${b.slice(12)}=`, (s) => `call it with ${s} please`],
  ["sk-", (b) => `sk-${b}`, (s) => `我的 key 是 ${s}，别外传`],
  ["sk-proj-", (b) => `sk-proj-${b}`, (s) => `use ${s} now`],
  ["ghp_", (b) => `ghp_${b}${b.slice(0, 12)}`, (s) => `my token is ${s} ok`],
  ["gho_", (b) => `gho_${b}${b.slice(0, 12)}`, (s) => `oauth ${s} ok`],
  ["ghs_", (b) => `ghs_${b}${b.slice(0, 12)}`, (s) => `server ${s} ok`],
  ["ghu_", (b) => `ghu_${b}${b.slice(0, 12)}`, (s) => `user ${s} ok`],
  ["github_pat_", (b) => `github_pat_${b}_${b}`, (s) => `pat ${s} ok`],
  ["xoxa-", (b) => `xoxa-${b}`, (s) => `slack ${s} ok`],
  ["xoxb-", (b) => `xoxb-${b.slice(0, 8)}-${b.slice(8)}`, (s) => `slack ${s} ok`],
  ["xoxp-", (b) => `xoxp-${b}`, (s) => `slack ${s} ok`],
  ["xoxr-", (b) => `xoxr-${b}`, (s) => `slack ${s} ok`],
  ["xoxs-", (b) => `xoxs-${b}`, (s) => `slack ${s} ok`],
];

const AWS: Array<[string, string, string]> = [
  ["AKIA", "AKIAABCDEFGHIJKLMNOP", "AKIA0123456789ABCDEF"],
  ["ASIA", "ASIAQRSTUVWXYZABCDEF", "ASIA9876543210QRSTUV"],
];
const JWT_ND = "eyJhbGciOiJIUzIiLCJ.eyJzdWIiOiJhYmMifQ.AbCdEfGhIjKlMnOp_-";
const JWT_WD = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz";

/** Keyword table of the ruling (new ones plus a sample of the kept ones); `:` and `=` both. */
const KEYWORDS = ["Authorization", "api-key", "api_key", "API key", "X-Api-Key", "token", "secret", "access_key", "password", "client_secret"];

export const MASK01_VECTORS: MaskVector[] = [
  ...prefixed.flatMap(([cls, make, sentence]) => [
    { name: `prefix ${cls} / no digit`, secret: make(ND).replace(/^Bearer /, ""), text: sentence(make(ND)) },
    { name: `prefix ${cls} / with digit`, secret: make(WD).replace(/^Bearer /, ""), text: sentence(make(WD)) },
  ]),
  ...AWS.flatMap(([cls, nd, wd]) => [
    { name: `prefix ${cls} / no digit`, secret: nd, text: `aws ${nd} key` },
    { name: `prefix ${cls} / with digit`, secret: wd, text: `aws ${wd} key` },
  ]),
  { name: "prefix JWT / no digit", secret: JWT_ND, text: `jwt ${JWT_ND} end` },
  { name: "prefix JWT / with digit", secret: JWT_WD, text: `jwt ${JWT_WD} end` },
  ...KEYWORDS.flatMap((key) =>
    [":", "="].flatMap((sep) => [
      { name: `keyword ${key}${sep} / no digit`, secret: "QwErTyUiOpAs", text: `${key}${sep} QwErTyUiOpAs (keep me)` },
      { name: `keyword ${key}${sep} / with digit`, secret: "QwE4TyU1Op9s", text: `${key} ${sep}QwE4TyU1Op9s (keep me)` },
    ]),
  ),
  // Authorization with a scheme: the whole value (scheme and token) becomes ***, even when the token is short.
  { name: "keyword Authorization: Bearer <short> / no digit", secret: "Bearer abc", text: "use Authorization: Bearer abc" },
  { name: "keyword Authorization: Basic <short> / with digit", secret: "Basic dXNlcjpw0", text: "Authorization= Basic dXNlcjpw0" },
];

/** Ordinary text that must stay byte-for-byte (false-positive guard). */
export const MASK01_KEEP: string[] = [
  "internationalization and uncharacteristically long words",
  "request 123e4567-e89b-12d3-a456-426614174000 done",
  "commit 5f2c180094e6f1348eef2fc685c15331ad270056 merged",
  "see /usr/local/lib/node_modules/typescript/lib/tsc.js and packages/governance/src/sensitive.ts",
  "the tokenizer splits words",
  "tokenizer=bpe",
  "the secretary said hi",
  "secretary: Alice",
  "token 用量: 1200",
  "max_tokens=4096",
  "secret santa",
  "the bearer of the message",
  "用 sk-learn 做分类",
];
