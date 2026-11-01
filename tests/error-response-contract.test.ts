import { Writable } from "node:stream";
import Fastify from "fastify";
import Ajv from "ajv";
import { expect, it } from "vitest";
import { ERROR_CODES, ForgeError } from "@forge/core/errors";
import { API_ERROR_RESPONSE_SCHEMA } from "@forge/contracts";
import { installErrorHandler } from "../apps/api/src/plugins/errors.js";

it("sends a registered error envelope, redacts details and logs each rejection once", async () => {
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
  const app = Fastify({ logger: { stream } });
  installErrorHandler(app);
  app.get("/rejected", async () => { throw new ForgeError("CFG-8501", { message: "参数错误", details: { field: "model", apiKey: "secret-value", nested: { password: "password-value" } } }); });
  app.get("/unavailable", async () => { throw new ForgeError("SYS-9003", { details: { sql: "private query" }, headers: { "Retry-After": "2" } }, new Error("private-cause")); });
  app.get("/unknown", async () => { throw new Error("private unknown error"); });
  app.get("/upstream", async () => { throw new ForgeError("HTP-4001", { message: 'MCP tools/list 错误: {"password":"private-upstream-payload"}' }); });
  app.get("/client-detail", async () => { throw new ForgeError("CFG-8501", { message: '配置错误 {"password":"private-message"}', details: { nested: { endpoint: "https://alice:private-password@example.test" } } }); });
  try {
    const validate = new Ajv().compile(API_ERROR_RESPONSE_SCHEMA);
    const rejection = await app.inject({ method: "GET", url: "/rejected" });
    expect(rejection.statusCode).toBe(400);
    const body = rejection.json();
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body.error.remedy).toBe(ERROR_CODES["CFG-8501"].remedy);
    expect(body.error.details).toEqual({ field: "model", apiKey: "***", nested: { password: "***" } });
    expect(rejection.body).not.toContain("secret-value");
    const unavailable = await app.inject({ method: "GET", url: "/unavailable" });
    expect(unavailable.headers["retry-after"]).toBe("2");
    expect(unavailable.json().error).toMatchObject({ code: "SYS-9003", details: null, retryable: true });
    expect(unavailable.body).not.toMatch(/private query|private-cause/);
    const unknown = await app.inject({ method: "GET", url: "/unknown" });
    expect(validate(unknown.json())).toBe(true);
    expect(unknown.json().error).toMatchObject({ code: "SYS-9001", message: "内部错误", details: null });
    expect(unknown.body).not.toContain("private unknown error");
    const upstream = await app.inject({ method: "GET", url: "/upstream" });
    expect(upstream.json().error.message).toBe(ERROR_CODES["HTP-4001"].userMessage);
    expect(upstream.body).not.toContain("private-upstream-payload");
    const client = await app.inject({ method: "GET", url: "/client-detail" });
    expect(client.body).not.toMatch(/private-message|private-password/);
    const failures = logs.map(line => JSON.parse(line)).filter(line => ["request rejected", "request failed", "unhandled error"].includes(line.msg));
    expect(failures).toHaveLength(5);
    expect(new Set(failures.map(line => line.reqId)).size).toBe(5);
    expect(logs.join("")).not.toMatch(/secret-value|password-value|private query|private-cause|private-message|private-password|private-upstream-payload/);
  } finally { await app.close(); }
});
