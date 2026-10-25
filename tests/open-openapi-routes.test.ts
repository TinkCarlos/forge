import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import openRoutes from "../apps/api/src/routes/open.js";

// P3 backlog: /open/v1/openapi.json must describe exactly the routes open.ts registers under /open/v1.
// The registered set is collected from Fastify's onRoute hook (no hard-coded list), so a new route without an
// OpenAPI entry (or a stale entry without a route) fails here.
const PREFIX = "/open/v1";
// open-platform.md §17: openapi.json is the public spec document itself (no API key), not an operation of the API;
// every operation in the spec carries `security: apiKey`. It is checked to be registered, then left out of the comparison.
const SPEC_ROUTE = "GET /openapi.json";
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

let app: FastifyInstance;
const registered = new Set<string>();

function toOpenApiPath(url: string): string {
  return url.slice(PREFIX.length).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith(`${PREFIX}/`)) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue; // Fastify's automatic HEAD twin of every GET route
      registered.add(`${method} ${toOpenApiPath(route.url)}`);
    }
  });
  await app.register(openRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("open.ts routes vs /open/v1/openapi.json", () => {
  it("collects the registered /open/v1 routes from Fastify", () => {
    expect(registered.size).toBeGreaterThan(1);
    expect(registered.has(SPEC_ROUTE)).toBe(true);
  });

  it("openapi paths (method + path) equal the registered routes, openapi.json itself excluded", async () => {
    const res = await app.inject({ method: "GET", url: `${PREFIX}/openapi.json` });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { servers: { url: string }[]; paths: Record<string, Record<string, unknown>> };
    expect(spec.servers[0]?.url).toBe(PREFIX);
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (HTTP_METHODS.has(method)) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    const expected = [...registered].filter((route) => route !== SPEC_ROUTE).sort();
    expect([...documented].sort()).toEqual(expected);
  });
});
