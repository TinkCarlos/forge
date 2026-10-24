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

// P2-01 follow-up: a path parameter over find-my-way's maxParamLength (100) raised FST_ERR_MAX_PARAM_LENGTH, which the
// frameworkErrors handler answered 500 SYS-9001. An over-long id can never exist: 404 RUN-7001, nothing echoed.
describe("over-long path parameter", () => {
  for (const [method, url] of [["GET", "/admin/api/agents/"], ["PATCH", "/admin/api/schedules/"], ["POST", "/open/v1/agents/"]] as const) {
    it(`${method} ${url}<300 chars> -> 404`, async () => {
      const id = `SEKRET${"x".repeat(300)}`;
      const res = await app.inject({ method, url: `${url}${id}${method === "POST" ? "/runs" : ""}`, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe("RUN-7001");
      expect(res.body).not.toContain("SEKRET"); // (the access log keeps the path, as for any request)
    });
  }
});
