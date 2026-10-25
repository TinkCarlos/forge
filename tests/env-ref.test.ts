import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { assertNoEnvRefs, config, encryptSecret, ENV_REF_CODE, isEnvRef, literalHeaders, type Principal } from "@forge/core";
import { callMcpTool } from "@forge/capabilities";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// AG / S-61: `env:` header values (and provider apiKey) are no longer expanded from process.env.
// Writes are refused with 400 CFG-8504; a stored `env:` value fails at runtime with CFG-8504 before any request.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRET = config.FORGE_MASTER_KEY;
let app: FastifyInstance;
let session: Session;
let h: Record<string, string>;
const mcpIds: string[] = [];
const providerIds: string[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const principal: Principal = { type: "user", id: ADMIN_ID, name: "admin", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" };
  session = await createSession(principal);
  h = { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
});

afterAll(async () => {
  // List this run's rows (it-envref-*), then delete by id.
  const mcp = await query<{ id: string }>("SELECT id FROM mcp_servers WHERE `key` LIKE ?", [`it-envref-%-${suffix}`]);
  for (const { id } of mcp) await execute("DELETE FROM mcp_servers WHERE id = ?", [id]);
  const providers = await query<{ id: string }>("SELECT id FROM llm_providers WHERE `key` LIKE ?", [`it-envref-%-${suffix}`]);
  for (const { id } of providers) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [id]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [id]);
  }
  const sources = await query<{ id: string }>("SELECT id FROM tool_sources WHERE `key` LIKE ?", [`it-envref-%-${suffix}`]);
  for (const { id } of sources) await execute("DELETE FROM tool_sources WHERE id = ?", [id]);
  const agents = await query<{ id: string }>("SELECT id FROM agents WHERE `key` LIKE ?", [`it-envref-%-${suffix}`]);
  for (const { id } of agents) await execute("DELETE FROM agents WHERE id = ?", [id]);
  await destroySession(session.token);
  await app.close();
});

const key = (tag: string) => `it-envref-${tag}-${suffix}`;
const expectRefused = (res: { statusCode: number; body: string; json: () => any }) => {
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe(ENV_REF_CODE);
  expect(res.body).not.toContain(SECRET);
};
const VARIANTS = ["env:FORGE_MASTER_KEY", "ENV:FORGE_MASTER_KEY", " env:FORGE_MASTER_KEY", "Env:SESSION_SECRET"];

describe("env: detection", () => {
  it("is case-insensitive and ignores surrounding whitespace", () => {
    for (const v of VARIANTS) expect(isEnvRef(v)).toBe(true);
    for (const v of ["Bearer env:X", "xenv:X", "envX", "", undefined, 1]) expect(isEnvRef(v)).toBe(false);
  });
  it("literalHeaders never expands, it refuses", () => {
    expect(literalHeaders('{"A":"b","N":1}')).toEqual({ A: "b" });
    expect(() => literalHeaders({ X: "env:FORGE_MASTER_KEY" })).toThrowError(expect.objectContaining({ code: ENV_REF_CODE }));
    expect(() => assertNoEnvRefs({ apiKey: "ENV:X" })).toThrowError(expect.objectContaining({ code: ENV_REF_CODE, httpStatus: 400 }));
  });
});

describe("S-61 config writes refuse env: with 400 CFG-8504", () => {
  it("POST /admin/api/mcp (all variants), nothing stored", async () => {
    for (const [i, v] of VARIANTS.entries()) {
      const res = await app.inject({ method: "POST", url: "/admin/api/mcp", headers: h, payload: { key: key(`mcp${i}`), url: "https://mcp.example.com/mcp", headers: { "X-Leak": v } } });
      expectRefused(res);
      expect(await repos.getMcpServerByKey(key(`mcp${i}`))).toBeFalsy();
    }
  });

  it("PATCH /admin/api/mcp/:id headers", async () => {
    const id = await repos.createMcpServer({ key: key("mcp-patch"), name: "it", url: "https://mcp.example.com/mcp", headers: { A: "b" } });
    mcpIds.push(id);
    expectRefused(await app.inject({ method: "PATCH", url: `/admin/api/mcp/${id}`, headers: h, payload: { headers: { "X-Leak": "env:FORGE_MASTER_KEY" } } }));
    expect(JSON.stringify((await repos.getMcpServer(id))?.headers_json)).not.toContain("env:");
  });

  it("POST /admin/api/tool-sources/import", async () => {
    const spec = { openapi: "3.0.0", info: { title: "t", version: "1" }, servers: [{ url: "https://api.example.com" }], paths: {} };
    expectRefused(await app.inject({ method: "POST", url: "/admin/api/tool-sources/import", headers: h, payload: { key: key("ts"), spec, headers: { "X-Leak": "env:FORGE_MASTER_KEY" } } }));
  });

  it("POST /admin/api/providers: headers and apiKey", async () => {
    expectRefused(await app.inject({ method: "POST", url: "/admin/api/providers", headers: h, payload: { key: key("p1"), baseUrl: "https://llm.example.com/v1", headers: { "X-Leak": "env:FORGE_MASTER_KEY" } } }));
    expectRefused(await app.inject({ method: "POST", url: "/admin/api/providers", headers: h, payload: { key: key("p2"), baseUrl: "https://llm.example.com/v1", apiKey: " env:FORGE_MASTER_KEY" } }));
    expect(await repos.getProviderByKey(key("p1"))).toBeFalsy();
    expect(await repos.getProviderByKey(key("p2"))).toBeFalsy();
  });

  it("PATCH /admin/api/providers/:id: headers and apiKey", async () => {
    const id = await repos.createProvider({ key: key("p-patch"), name: "it", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1" });
    providerIds.push(id);
    expectRefused(await app.inject({ method: "PATCH", url: `/admin/api/providers/${id}`, headers: h, payload: { apiKey: "ENV:FORGE_MASTER_KEY" } }));
    expectRefused(await app.inject({ method: "PATCH", url: `/admin/api/providers/${id}`, headers: h, payload: { headers: { A: "env:SESSION_SECRET" } } }));
    expect((await repos.getProviderById(id))?.api_key_encrypted ?? null).toBeNull();
  });

  it("POST /admin/api/plugins/install refuses before creating anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/plugins/install",
      headers: h,
      payload: {
        key: key("plg"),
        resources: {
          agents: [{ key: key("agent") }],
          providers: [{ key: key("plg-p"), baseUrl: "https://llm.example.com/v1", apiKey: "env:FORGE_MASTER_KEY" }],
        },
      },
    });
    expectRefused(res);
    expect(await repos.getAgentByKey(key("agent"))).toBeFalsy();
    expect(await repos.getProviderByKey(key("plg-p"))).toBeFalsy();
  });
});

describe("S-61 runtime: a stored env: value is never sent", () => {
  it("callMcpTool -> {ok:false, errorCode:CFG-8504} before the outbound check", async () => {
    const result = await callMcpTool({ url: "https://mcp.example.com/mcp", headers_json: JSON.stringify({ "X-Leak": "env:FORGE_MASTER_KEY" }) }, "t", {});
    expect(result).toMatchObject({ ok: false, errorCode: ENV_REF_CODE });
    expect(result.content).not.toContain(SECRET);
  });

  it("provider test with a stored env: apiKey -> 400 CFG-8504, no upstream call", async () => {
    const id = await repos.createProvider({ key: key("p-run"), name: "it", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKeyEncrypted: encryptSecret("env:FORGE_MASTER_KEY", config.FORGE_MASTER_KEY) });
    providerIds.push(id);
    await repos.createModel({ providerId: id, key: "it-model", displayName: "it" });
    expectRefused(await app.inject({ method: "POST", url: `/admin/api/providers/${id}/test`, headers: h }));
  });
});
