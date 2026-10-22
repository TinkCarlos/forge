import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("buildApp (route-level smoke via inject)", () => {
  it("serves /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects admin API without session with 401 in error format", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toHaveProperty("code");
  });
});
