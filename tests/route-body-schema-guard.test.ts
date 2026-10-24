import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// F1 (P1) structural guard, pure (no DB, no .env): reads apps/api/src/routes/** and fails CI when
//  - a write route (POST / PUT / PATCH / DELETE) reads the request body (bodyOf(request) / request.body) but declares
//    no `schema: ROUTE_SCHEMAS.x`, or
//  - a route declares a schema but its handler never calls assertValidInput (attachValidation would then accept
//    anything silently), or
//  - a route is registered some other way than the patterns below (so the guard cannot be bypassed by a new helper).
// The DB test tests/route-schema-coverage.test.ts then sends every schema route an invalid body (400) and checks the
// 401 -> 403 -> 404 -> 400 order.
const ROOT = new URL("../apps/api/src/routes/", import.meta.url).pathname;
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"|\bscheduleByIdRoute\(app,\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]*)"/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}

type Route = { file: string; method: string; url: string; readsBody: boolean; schema: string | null; part: "body" | "querystring" | null; validates: boolean };

export function routesOf(file: string, src: string): Route[] {
  const matches = [...src.matchAll(REGISTRATION)];
  return matches.map((m, i) => {
    const segment = src.slice(m.index, matches[i + 1]?.index ?? src.length);
    const method = (m[1] ?? m[3] ?? "").toUpperCase();
    const url = m[2] ?? `/admin/api/schedules/:id${m[4] ?? ""}`;
    const schema = /schema: ROUTE_SCHEMAS\.(\w+)/.exec(segment)?.[1] ?? null;
    const query = /assertValidInput\(request, "querystring"\)/.test(segment);
    return {
      file: file.slice(ROOT.length),
      method,
      url,
      readsBody: /\bbodyOf\(request\)|\brequest\.body\b/.test(segment),
      schema,
      part: schema ? (query ? "querystring" : "body") : null,
      validates: /assertValidInput\(request(?:, "(?:body|querystring)")?\)/.test(segment),
    };
  });
}

const all = files(ROOT).flatMap((file) => routesOf(file, readFileSync(file, "utf8")));
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

describe("F1: every body-accepting write route declares a schema and calls the validator", () => {
  it("the scan sees the routes (guards the regex)", () => {
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((r) => WRITE.has(r.method) && r.readsBody).length).toBeGreaterThanOrEqual(30);
  });

  it("no write route reads the body without a schema", () => {
    expect(all.filter((r) => WRITE.has(r.method) && r.readsBody && !r.schema).map((r) => `${r.file} ${r.method} ${r.url}`)).toEqual([]);
  });

  it("no route declares a schema without calling assertValidInput", () => {
    expect(all.filter((r) => r.schema && !r.validates).map((r) => `${r.file} ${r.method} ${r.url} (${r.schema})`)).toEqual([]);
  });

  it("no route is registered outside the scanned patterns", () => {
    const stray: string[] = [];
    for (const file of files(ROOT)) {
      const src = readFileSync(file, "utf8");
      // Any `<x>.<verb>("/...` or `<x>.route({` registration; only app.<verb>("/...") and the one app.route inside
      // scheduleByIdRoute (whose call sites are scanned instead) are allowed.
      for (const m of src.matchAll(/\b(\w+)\.(?:(get|post|put|patch|delete|all)\(\s*["'`]\/|(route)\(\s*\{)/g)) {
        if (m[1] === "app" && m[2]) continue;
        if (m[1] === "app" && m[3] && file.endsWith("schedules.ts") && (src.match(/\bapp\.route\(/g) ?? []).length === 1) continue;
        stray.push(`${file.slice(ROOT.length)}: ${m[0]}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("the guard itself flags a body route without a schema and a schema route without the validator", () => {
    const src = [
      'app.post("/x", async (request) => { const body = bodyOf(request); return body; });',
      'app.patch("/y", { schema: ROUTE_SCHEMAS.agentPatch, attachValidation: true }, async (request) => { return bodyOf(request); });',
      'app.post("/z", { schema: ROUTE_SCHEMAS.agentPatch, attachValidation: true }, async (request) => { assertValidInput(request); return bodyOf(request); });',
    ].join("\n");
    const routes = routesOf(`${ROOT}fake.ts`, src);
    expect(routes.map((r) => [r.url, !!r.schema, r.validates])).toEqual([["/x", false, false], ["/y", true, false], ["/z", true, true]]);
  });
});
