import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/api/src/app.js";
import { REDACTED } from "../apps/api/src/plugins/log-sanitize.js";

// K-26 regression against the REAL buildApp() (DB-backed suite: importing it loads @forge/core + @forge/store).
// apps/console/dist is a build artifact that is not checked in, so the test chdirs into a temp tree that contains a
// stub console build; static roots and the /next/* fallback resolve from process.cwd(). No route here touches the DB.
let tmp = "";
let cwd = "";
let app: FastifyInstance;
const lines: string[] = [];
const INDEX = "<!doctype html><title>forge-next-real-app-index</title>";

beforeAll(async () => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-real-404-"));
  fs.mkdirSync(path.join(tmp, "apps/console/dist/assets"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "apps/console/public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "apps/console/dist/index.html"), INDEX);
  fs.writeFileSync(path.join(tmp, "apps/console/public/index.html"), "<html>legacy</html>");
  process.chdir(tmp);
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  // Caller-provided logger options without serializers: buildApp must still apply the K-26 req serializer.
  app = await buildApp({ logger: { level: "info", stream } });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  process.chdir(cwd);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("real buildApp: /next/ SPA fallback with the sanitized 404 handler installed", () => {
  it("/next/agents -> 200 index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/next/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toBe(INDEX);
  });
});

describe("real buildApp: unknown route 404 is sanitized in response and logs", () => {
  it("/admin/api/does-not-exist?token=x -> 404, token value redacted", async () => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url: "/admin/api/does-not-exist?token=x&page=2" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toMatchObject({ error: "Not Found", statusCode: 404 });
    expect(body.message).toBe(`Route GET:/admin/api/does-not-exist?token=${REDACTED}&page=2 not found`);
    expect(res.body).toContain(REDACTED);
    expect(res.body).not.toContain("token=x");
    expect(res.body).toContain("page=2");

    const log = lines.join("");
    expect(log).toContain("does-not-exist");
    expect(log).toContain(REDACTED);
    expect(log).not.toContain("token=x");
    // Both the req serializer (incoming request line) and the 404 message were sanitized.
    const entries = lines.map((l) => JSON.parse(l) as { msg?: string; req?: { url?: string } });
    expect(entries.some((e) => e.req?.url?.includes(REDACTED))).toBe(true);
    expect(entries.some((e) => e.msg?.startsWith("Route GET:") && e.msg.includes(REDACTED))).toBe(true);
  });
});
