import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/app.js";

// P2-01 / K26-BADURL: a malformed URL is answered by frameworkErrors with the unified error body (400 CFG-8501) and
// nothing of the URL, path or query echoed back; the request log line is sanitized too.
const lines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  app = await buildApp({ logger: { level: "info", stream } });
  await app.ready();
});
afterAll(async () => app?.close());

describe("malformed URL", () => {
  for (const url of ["/admin/api/%E0%A4%A?token=SEKRET", "/next/%E0%A4%A?token=SEKRET"]) {
    it(url, async () => {
      lines.length = 0;
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string; requestId: string } };
      expect(body.error.code).toBe("CFG-8501");
      expect(typeof body.error.requestId).toBe("string");
      for (const leak of ["SEKRET", "token", "%E0", "admin/api", "next/"]) expect(res.body).not.toContain(leak);
      expect(lines.join("\n")).not.toContain("SEKRET");
    });
  }
});
