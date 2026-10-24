import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";

// Structural guard on body FIELDS (pure, no DB / .env; @forge/core is stubbed because it parses the config on import).
// tests/route-body-schema-guard.test.ts only checks that a body route HAS a schema; agent PATCH had one (since 44f7a55)
// that listed only its string fields, so `apiEnabled: "yes"` was never validated and stored as 1.
//  1. every top-level body field a handler reads (body.x, stringBody/requireBodyString/jsonBody(body, "x"), and the
//     schedules `input` alias) is a property of that route's body schema, and that property declares a `type`;
//  2. every property of every body schema declares a `type` (recursively);
//  3. additionalProperties: body schemas leave it unset (undeclared fields pass validation and are never read, by 1),
//     or set it to false, in which case Fastify's ajv (removeAdditional, kept on in app.ts) strips undeclared fields
//     before the handler: never rejected, never read. Pinned below on a bare Fastify with the app's ajv options.
//  4. the body object itself is only used through those accessors (no whole-body pass-through the scan cannot see).
const { ForgeError } = vi.hoisted(() => ({
  ForgeError: class ForgeError extends Error {
    constructor(public readonly code: string, message: string, public readonly httpStatus = 400, public readonly details?: unknown) {
      super(message);
    }
  },
}));
vi.mock("@forge/core", async () => ({
  ...(await import("../packages/core/src/cron.js")),
  ForgeError,
  errors: { invalid: (m: string, details?: unknown) => new ForgeError("CFG-8501", m, 400, details) },
}));
import { AJV_CUSTOM_OPTIONS, ROUTE_SCHEMAS, assertValidInput } from "../apps/api/src/plugins/input-schema.js";

type Schema = { type?: unknown; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: unknown };
const ROOT = new URL("../apps/api/src/routes/", import.meta.url).pathname;
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"|\bscheduleByIdRoute\(app,\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]*)"/g;
const HELPERS = "stringBody|requireBodyString|jsonBody|arrayBody|enumBody";
/** Whole-body helpers and the fields they read (checked against their source below). */
const WHOLE_BODY_HELPERS: Record<string, { file: string; reads: string[] }> = { webhookUrlOf: { file: "admin/apps.ts", reads: ["webhookUrl"] } };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}

type Route = { id: string; schema: string | null; reads: string[]; stray: string[] };

export function scan(file: string, src: string): Route[] {
  const matches = [...src.matchAll(REGISTRATION)];
  return matches.map((m, i) => {
    const segment = src.slice(m.index, matches[i + 1]?.index ?? src.length);
    const method = (m[1] ?? m[3] ?? "").toUpperCase();
    const url = m[2] ?? `/admin/api/schedules/:id${m[4] ?? ""}`;
    const usesInputAlias = /\bconst input = body as\b/.test(segment);
    const reads = new Set<string>();
    const stray: string[] = [];
    for (const occ of segment.matchAll(/\bbody\b/g)) {
      const lineStart = segment.lastIndexOf("\n", occ.index) + 1;
      const line = segment.slice(lineStart, segment.indexOf("\n", occ.index) === -1 ? undefined : segment.indexOf("\n", occ.index));
      const col = occ.index - lineStart;
      if (/^\s*(\/\/|\*)/.test(line) || (line.indexOf("//") !== -1 && line.indexOf("//") < col)) continue; // comment
      const before = segment.slice(Math.max(0, occ.index - 40), occ.index);
      const after = segment.slice(occ.index + 4, occ.index + 60);
      const field = /^\.(\w+)/.exec(after)?.[1] ?? (new RegExp(`\\b(?:${HELPERS})\\($`).test(before) ? /^,\s*"(\w+)"/.exec(after)?.[1] : undefined);
      const whole = /\b(\w+)\($/.exec(before)?.[1];
      if (field) reads.add(field);
      else if (/\bconst $/.test(before) && /^ = bodyOf\(request\)/.test(after)) continue;
      else if (/\bconst input = $/.test(before) && /^ as\b/.test(after)) continue;
      else if (/\.$/.test(before)) continue; // `x.body`: another object's property
      else if (/^\s*:/.test(after)) continue; // `body:` as an object key (response bodies, inline schemas)
      // Open-platform idempotency: the raw body is hashed to detect a reused key with a different request; no field is
      // read from it, so undeclared fields can only make the hash differ (409), never change what is stored.
      else if (/\bidempotencyRequestHash\(\{[^)]*$/.test(line.slice(0, col)) && /^\s*\}\)/.test(after)) continue;
      else if (whole && WHOLE_BODY_HELPERS[whole] && /^\)/.test(after)) WHOLE_BODY_HELPERS[whole]!.reads.forEach((f) => reads.add(f));
      else stray.push(line.trim().slice(0, 120));
    }
    if (usesInputAlias) for (const r of segment.matchAll(/\binput\.(\w+)/g)) reads.add(r[1]!);
    return { id: `${file.slice(ROOT.length)} ${method} ${url}`, schema: /schema: ROUTE_SCHEMAS\.(\w+)/.exec(segment)?.[1] ?? null, reads: [...reads].sort(), stray };
  });
}

const routes = files(ROOT).flatMap((file) => scan(file, readFileSync(file, "utf8")));
const bodySchemas = Object.entries(ROUTE_SCHEMAS as Record<string, { body?: Schema }>).filter(([, s]) => s.body) as Array<[string, { body: Schema }]>;

function untyped(schema: Schema, path: string): string[] {
  const out: string[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.type === undefined) out.push(`${path}.${key}`);
    out.push(...untyped(prop, `${path}.${key}`));
    if (prop.items) out.push(...untyped(prop.items, `${path}.${key}[]`));
  }
  return out;
}

describe("body fields read by handlers are declared and typed", () => {
  it("the scan sees routes and their body reads (guards the regexes)", () => {
    const patch = routes.find((r) => r.id === "admin/agents.ts PATCH /admin/api/agents/:id");
    expect(patch?.schema).toBe("agentPatch");
    expect(patch?.reads).toEqual(expect.arrayContaining(["apiEnabled", "name", "status"]));
    expect(routes.find((r) => r.id.endsWith("PATCH /admin/api/schedules/:id"))?.reads).toEqual(expect.arrayContaining(["cron", "timezone", "name"]));
    expect(routes.filter((r) => r.reads.length).length).toBeGreaterThanOrEqual(30);
  });

  it("every field a handler reads is a schema property with a type", () => {
    const missing: string[] = [];
    for (const r of routes) {
      if (!r.reads.length) continue;
      const props = r.schema ? (ROUTE_SCHEMAS as Record<string, { body?: Schema }>)[r.schema]?.body?.properties : undefined;
      for (const field of r.reads) {
        const prop = props?.[field];
        if (!prop) missing.push(`${r.id}: ${field} not in ${r.schema ?? "(no schema)"}`);
        else if (prop.type === undefined) missing.push(`${r.id}: ${field} has no type`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every property of every body schema declares a type (recursively)", () => {
    expect(bodySchemas.flatMap(([name, s]) => untyped(s.body, name))).toEqual([]);
  });

  it("handlers use the body only through the scanned accessors", () => {
    expect(routes.flatMap((r) => r.stray.map((s) => `${r.id}: ${s}`))).toEqual([]);
  });

  it("whole-body helpers read only the fields listed for them", () => {
    for (const [name, h] of Object.entries(WHOLE_BODY_HELPERS)) {
      const src = readFileSync(join(ROOT, h.file), "utf8");
      const start = src.indexOf(`function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const fn = src.slice(start, src.indexOf("\n}\n", start));
      const fields = [...fn.matchAll(new RegExp(`\\b(?:${HELPERS})\\(body,\\s*"(\\w+)"`, "g"))].map((m) => m[1]);
      expect([name, fields, /\bbody\.\w|\bbody\[/.test(fn)]).toEqual([name, h.reads, false]);
    }
  });

  it("the scanner flags an undeclared read and a whole-body pass (self-test)", () => {
    const src = 'app.patch("/x", { schema: ROUTE_SCHEMAS.agentPatch, attachValidation: true }, async (request) => { const body = bodyOf(request); assertValidInput(request); save(body.secretFlag, body); // body in a comment is ignored\n });';
    const [r] = scan(`${ROOT}fake.ts`, src);
    expect(r!.reads).toEqual(["secretFlag"]);
    expect(r!.stray).toHaveLength(1);
  });
});

describe("additionalProperties on write body schemas", () => {
  it("is either unset or false (no permissive sub-schema that would let undeclared fields through typed loosely)", () => {
    expect(bodySchemas.filter(([, s]) => s.body.additionalProperties !== undefined && s.body.additionalProperties !== false).map(([n]) => n)).toEqual([]);
  });

  it("behaviour with the app's ajv options: unset -> undeclared field passes untouched; false -> stripped, not rejected", async () => {
    const app = Fastify({ ajv: { customOptions: AJV_CUSTOM_OPTIONS } });
    const seen: Record<string, unknown> = {};
    for (const [url, additionalProperties] of [["/open", undefined], ["/closed", false]] as const) {
      const body = { type: "object", properties: { name: { type: "string", maxLength: 8 } }, ...(additionalProperties === false ? { additionalProperties } : {}) };
      app.post(url, { schema: { body }, attachValidation: true }, async (request) => {
        assertValidInput(request);
        seen[url] = request.body;
        return { ok: true };
      });
    }
    await app.ready();
    for (const url of ["/open", "/closed"]) {
      const res = await app.inject({ method: "POST", url, payload: { name: "a", extra: "yes" } });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
    expect(seen).toEqual({ "/open": { name: "a", extra: "yes" }, "/closed": { name: "a" } });
    await app.close();
  });

  it("agent PATCH: apiEnabled must be a boolean (schema-level)", async () => {
    const app = Fastify({ ajv: { customOptions: AJV_CUSTOM_OPTIONS } });
    app.setErrorHandler((e: Error & { httpStatus?: number; details?: unknown }, _req, reply) => reply.status(e.httpStatus ?? 500).send({ details: e.details }));
    app.patch("/a", { schema: ROUTE_SCHEMAS.agentPatch, attachValidation: true }, async (request) => {
      assertValidInput(request);
      return { ok: true };
    });
    await app.ready();
    for (const apiEnabled of ["yes", "true", 1, 0, null, {}, []]) {
      const res = await app.inject({ method: "PATCH", url: "/a", payload: { apiEnabled } });
      expect([JSON.stringify(apiEnabled), res.statusCode]).toEqual([JSON.stringify(apiEnabled), 400]);
    }
    for (const apiEnabled of [true, false]) expect((await app.inject({ method: "PATCH", url: "/a", payload: { apiEnabled } })).statusCode).toBe(200);
    await app.close();
  });
});
