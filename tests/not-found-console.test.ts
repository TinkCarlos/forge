import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Both modules are DB-free: console.ts only uses fs/path, log-sanitize.ts only a fastify type.
import consoleRoutes from "../apps/api/src/routes/console";
import { installSanitizedNotFoundHandler, REDACTED, requestLogSerializers } from "../apps/api/src/plugins/log-sanitize";

// K-26 + 404 wiring. buildApp() itself loads @forge/core config and @forge/store (needs DATABASE_URL), so this mirrors
// its registration order for the parts that matter here: logger serializers, @fastify/static on /assets/,
// installSanitizedNotFoundHandler, consoleRoutes (/next/* SPA fallback). Files come from a temp dir (process.chdir).
let tmp = "";
let cwd = "";
let app: FastifyInstance;
const lines: string[] = [];
const INDEX = "<!doctype html><title>forge-next-test-index</title>";

beforeAll(async () => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-404-"));
  fs.mkdirSync(path.join(tmp, "apps/console/dist/assets"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "apps/console/public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "apps/console/dist/index.html"), INDEX);
  fs.writeFileSync(path.join(tmp, "apps/console/dist/assets/app-abc.js"), "console.log(1)");
  fs.writeFileSync(path.join(tmp, "apps/console/public/index.html"), "<html>legacy</html>");
  fs.writeFileSync(path.join(tmp, "apps/console/public/app.css"), "body{}");
  process.chdir(tmp);
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  app = Fastify({ logger: { level: "info", stream, serializers: requestLogSerializers } });
  await app.register(fastifyStatic, { root: path.resolve(process.cwd(), "apps/console/public"), prefix: "/assets/" });
  installSanitizedNotFoundHandler(app);
  await app.register(consoleRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  process.chdir(cwd);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("/next/ SPA fallback is not affected by the sanitized 404 handler", () => {
  it("/next/agents deep link -> 200 index.html, no-cache", async () => {
    const res = await app.inject({ method: "GET", url: "/next/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });
  it("OPS-020: /next/nope.js (missing file) -> 200 index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/next/nope.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });
  it("/next/assets/app-abc.js -> the real asset, immutable", async () => {
    const res = await app.inject({ method: "GET", url: "/next/assets/app-abc.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log(1)");
    expect(String(res.headers["cache-control"])).toContain("immutable");
  });
  it("/next -> redirect to /next/, legacy / and /assets/ still served", async () => {
    expect((await app.inject({ method: "GET", url: "/next" })).headers.location).toBe("/next/");
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("legacy");
    expect((await app.inject({ method: "GET", url: "/assets/app.css" })).statusCode).toBe(200);
  });
});

describe("unmatched routes go through the sanitized 404 handler", () => {
  it("/admin/api/does-not-exist?token=x -> 404, logs and body only contain [REDACTED]", async () => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url: "/admin/api/does-not-exist?token=x&q=1" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "RUN-7001", message: "资源不存在", requestId: expect.any(String), details: null, retryable: false } }); // P3-01: unified body, no path echo
    expect(res.body).not.toContain("does-not-exist");
    const logs = lines.join("");
    expect(logs).toContain(`token=${REDACTED}`);
    expect(logs).not.toMatch(/token=x\b/);
    expect(logs).toContain("not found");
  });
  it("missing /assets/ file (fastify-static callNotFound) also uses the sanitized handler", async () => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url: "/assets/missing.css?api_key=SECRETVALUE" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("SECRETVALUE");
    expect(lines.join("")).not.toContain("SECRETVALUE");
  });
});
