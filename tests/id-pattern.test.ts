import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as core from "@forge/core";

// K-33 contract: entity ids come only from ulidWithPrefix (3 lowercase letters + "_" + the first 22 chars of a ULID,
// 26 total = id CHAR(26)) or are 26-char plain ULIDs (seed). The shared pattern in @forge/core is what the consoles
// validate path segments with; the frontend copies must equal ID_PATTERN_SOURCE (consistency test lands after the
// frontend merge). PATH_PARAM_KINDS says which route path params carry such ids and which carry slugs.
const ROOT = new URL("../", import.meta.url).pathname;
const FRONTEND_SOURCE = "^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z]{3}_[0-9A-HJKMNP-TV-Z]{22})$";
const { ID_PATTERN, ID_PATTERN_SOURCE, ID_PREFIXES, PATH_PARAM_KINDS, ulidWithPrefix } = core as unknown as {
  ID_PATTERN: RegExp;
  ID_PATTERN_SOURCE: string;
  ID_PREFIXES: readonly string[];
  PATH_PARAM_KINDS: Readonly<Record<string, "id" | "slug">>;
  ulidWithPrefix: (prefix: string) => string;
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}
const sources = [...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src")), join(ROOT, "apps/api/src")].flatMap(files);

describe("shared id pattern (@forge/core)", () => {
  it("ID_PATTERN_SOURCE is exactly the pattern the consoles use, ID_PATTERN is built from it (anchored)", () => {
    expect(ID_PATTERN_SOURCE).toBe(FRONTEND_SOURCE);
    expect(ID_PATTERN).toBeInstanceOf(RegExp);
    expect([ID_PATTERN.source, ID_PATTERN.flags]).toEqual([FRONTEND_SOURCE, ""]);
  });

  it("ID_PREFIXES lists exactly the prefixes passed to ulidWithPrefix in the code, all 3 lowercase letters", () => {
    const used = new Set<string>();
    const calls: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bulidWithPrefix\(([^)]*)\)/g)) {
        if (m[0].startsWith("ulidWithPrefix(prefix")) continue; // the definition
        calls.push(`${file.slice(ROOT.length)}: ${m[0]}`);
        const literal = /^"([^"]*)"$/.exec(m[1]!.trim());
        expect(literal, `non-literal prefix: ${file.slice(ROOT.length)} ${m[0]}`).not.toBeNull();
        used.add(literal![1]!);
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(28);
    expect([...used].sort()).toEqual([...ID_PREFIXES].sort());
    expect(new Set(ID_PREFIXES).size).toBe(ID_PREFIXES.length);
    for (const p of ID_PREFIXES) expect(p).toMatch(/^[a-z]{3}$/);
  });

  it("every real prefix: 2000 generated ids are 26 chars and pass ID_PATTERN", () => {
    for (const prefix of ID_PREFIXES) {
      for (let i = 0; i < 2000; i += 1) {
        const id = ulidWithPrefix(prefix);
        if (id.length !== 26 || !ID_PATTERN.test(id)) expect.fail(`${prefix}: ${id}`);
      }
    }
  });

  it("seed ids (26-char plain ULIDs) pass", () => {
    const seed = readFileSync(join(ROOT, "scripts/seed.ts"), "utf8");
    const ids = [...seed.matchAll(/"([0-9A-Z]{26})"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });

  it.each([
    "", "agt_", "agt_01M5PK6G1GPZ3APBN3QNX", "agt_01M5PK6G1GPZ3APBN3QNXRR", "AGT_01M5PK6G1GPZ3APBN3QNXR", "ag_01M5PK6G1GPZ3APBN3QNXR1",
    "agnt_01M5PK6G1GPZ3APBN3QNX", "agt-01M5PK6G1GPZ3APBN3QNXR", "agt_01m5pk6g1gpz3apbn3qnxr", "agt_01M5PK6G1GPZ3APBN3QNXO", "agt_01M5PK6G1GPZ3APBN3QNXI",
    "agt_01M5PK6G1GPZ3APBN3QNXL", "agt_01M5PK6G1GPZ3APBN3QNXU", "01J0000000000000000000000", "01J000000000000000000000000", "01j00000000000000000000000",
    "../users", "..%2F..%2Fx", "agt_01M5PK6G1GPZ3APBN3QNXR\n", " agt_01M5PK6G1GPZ3APBN3QNXR", "agt_01M5PK6G1GPZ3APBN3QNXR?x", "x".repeat(5000),
  ])("rejects %j", (bad) => {
    expect(ID_PATTERN.test(bad)).toBe(false);
  });

  it.each(["", "ab", "abcd", "Agt", "AGT", "a_c", "ag1", "агт"])("ulidWithPrefix refuses prefix %j (would change the suffix length)", (prefix) => {
    expect(() => ulidWithPrefix(prefix)).toThrow(/prefix/);
  });
});

describe("route path params: id or slug (PATH_PARAM_KINDS)", () => {
  const REGISTRATION = /\bapp\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"|\bscheduleByIdRoute\(app,\s*"[A-Z]+",\s*"([^"]*)"/g;
  const routes = files(join(ROOT, "apps/api/src/routes")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(REGISTRATION)].map((m) => ({ file: file.slice(ROOT.length), path: m[1] ?? `/admin/api/schedules/:id${m[2]}` })),
  );

  it("every path param of every route is listed; :id carries a generated id, :key a slug (open-platform agent key)", () => {
    const params = routes.flatMap((r) => [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ ...r, name: m[1]! })));
    expect(params.length).toBeGreaterThanOrEqual(37);
    expect(params.filter((p) => !(p.name in PATH_PARAM_KINDS)).map((p) => `${p.file} ${p.path}`)).toEqual([]);
    expect(PATH_PARAM_KINDS).toEqual({ id: "id", key: "slug" });
    expect(params.filter((p) => p.name === "key").map((p) => p.path).sort()).toEqual(["/open/v1/agents/:key", "/open/v1/agents/:key/invoke", "/open/v1/agents/:key/runs"]);
  });
});
