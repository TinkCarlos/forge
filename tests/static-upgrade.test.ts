import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import consoleRoutes from "../apps/api/src/routes/console";
import { installSanitizedNotFoundHandler } from "../apps/api/src/plugins/log-sanitize";

// OPS-022: @fastify/static upgrade guard. Pins the behaviour buildApp() relies on (/assets/ legacy static, /next/* SPA
// fallback via reply.sendFile) so the 8.x -> 10.x bump cannot silently change Content-Type, cache headers or traversal.
let tmp = "";
let cwd = "";
let app: FastifyInstance;
const INDEX = "<!doctype html><title>forge-ops022-index</title>";

beforeAll(async () => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ops022-"));
  fs.mkdirSync(path.join(tmp, "apps/console/dist/assets"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "apps/console/public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "apps/console/dist/index.html"), INDEX);
  fs.writeFileSync(path.join(tmp, "apps/console/dist/assets/app-abc.js"), "console.log(1)");
  fs.writeFileSync(path.join(tmp, "apps/console/dist/assets/app-abc.css"), "body{}");
  fs.writeFileSync(path.join(tmp, "apps/console/dist/favicon.svg"), "<svg/>");
  fs.writeFileSync(path.join(tmp, "apps/console/public/index.html"), "<html>legacy</html>");
  fs.writeFileSync(path.join(tmp, "apps/console/public/app.css"), "body{}");
  fs.writeFileSync(path.join(tmp, "apps/console/public/app.js"), "1");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "TOP-SECRET-OPS022");
  process.chdir(tmp);
  app = Fastify({ logger: false });
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

describe("OPS-022 version floor", () => {
  it("@fastify/static >= 10.1.2 (GHSA-pr96-94w5-mx2h, GHSA-x428-ghpx-8j92, GHSA-83w8-p2f5-377r, GHSA-8pvw-jcv7-9cmj)", () => {
    const req = createRequire(path.join(cwd, "package.json"));
    const v = (req("@fastify/static/package.json") as { version: string }).version.split(".").map(Number);
    const [maj = 0, min = 0, pat = 0] = v;
    expect(maj > 10 || (maj === 10 && (min > 1 || (min === 1 && pat >= 2)))).toBe(true);
  });
});

describe("OPS-022 /next/ SPA fallback and headers", () => {
  it("deep link -> index.html, text/html, no-cache", async () => {
    const res = await app.inject({ method: "GET", url: "/next/agents/abc" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(String(res.headers["content-type"])).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });
  it("/next/ root -> index.html no-cache", async () => {
    const res = await app.inject({ method: "GET", url: "/next/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });
  it("hashed js -> javascript content-type, 1y immutable", async () => {
    const res = await app.inject({ method: "GET", url: "/next/assets/app-abc.js" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
  it("hashed css -> text/css, 1y immutable", async () => {
    const res = await app.inject({ method: "GET", url: "/next/assets/app-abc.css" });
    expect(String(res.headers["content-type"])).toMatch(/^text\/css/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
  it("non-hashed root file -> served without long cache", async () => {
    const res = await app.inject({ method: "GET", url: "/next/favicon.svg" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^image\/svg\+xml/);
    expect(String(res.headers["cache-control"] ?? "")).not.toContain("max-age=31536000");
  });
  it("legacy /assets/ keeps content-type", async () => {
    const css = await app.inject({ method: "GET", url: "/assets/app.css" });
    expect(css.statusCode).toBe(200);
    expect(String(css.headers["content-type"])).toMatch(/^text\/css/);
    const js = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(String(js.headers["content-type"])).toMatch(/javascript/);
  });
});

describe("OPS-022 traversal never leaks files outside the roots", () => {
  const probes = [
    "/assets/../secret.txt", "/assets/%2e%2e/%2e%2e/%2e%2e/secret.txt", "/assets/..%2f..%2f..%2fsecret.txt",
    "/assets/..%5c..%5c..%5csecret.txt", "/assets/%252e%252e/secret.txt", "/assets//../../../secret.txt",
    "/next/../secret.txt", "/next/%2e%2e/%2e%2e/%2e%2e/secret.txt", "/next/..%2f..%2f..%2fsecret.txt",
    "/next/..%5c..%5c..%5csecret.txt", "/next/assets/..%2f..%2f..%2f..%2fsecret.txt",
  ];
  for (const url of probes) {
    it(`${url} -> no secret`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain("TOP-SECRET-OPS022");
      if (url.startsWith("/assets/")) expect([400, 403, 404]).toContain(res.statusCode);
    });
  }
});
