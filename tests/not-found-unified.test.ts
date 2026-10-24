import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/app.js";

// P3-01: an unknown route answers 404 with the unified error body {error:{code:"RUN-7001", message, requestId,
// details:null, retryable:false}} (same as an unknown id / over-long id), under /admin/api, /open/v1, /integration/v1
// and everywhere else; nothing of the path or query is echoed (K-26). A wrong method on an existing path is the same
// 404 (Fastify routes by method + path; no 405). /next/* keeps the SPA fallback (P1-07).
let app: FastifyInstance;
const SECRET = "tok-p301-secret";

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => app?.close());

describe("P3-01 unified 404", () => {
  it.each([
    ["GET", `/admin/api/qa-no-such-route?token=${SECRET}`],
    ["GET", "/open/v1/qa-no-such-route"],
    ["POST", `/integration/v1/qa-no-such-route?code=${SECRET}`],
    ["GET", `/qa-no-such-route-${SECRET}`],
    ["DELETE", "/healthz"],
    ["PUT", "/admin/api/agents"],
  ] as const)("%s %s -> 404 RUN-7001, no path / query echoed", async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string; requestId: unknown; details: unknown; retryable: boolean } };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toMatchObject({ code: "RUN-7001", message: "资源不存在", details: null, retryable: false });
    expect(typeof body.error.requestId).toBe("string");
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("qa-no-such-route");
    expect(res.body).not.toContain("healthz");
  });

  it("/next/* still falls back to the SPA", async () => {
    const res = await app.inject({ method: "GET", url: "/next/qa-no-such-page" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/html");
  });
});
