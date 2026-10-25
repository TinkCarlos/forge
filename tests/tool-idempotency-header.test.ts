import { describe, expect, it, vi } from "vitest";

// TK-06 (pure, no DB; design §3.1): OpenAPI tools send `Idempotency-Key: <ToolContext.idempotencyKey>` on every method,
// replacing a configured header of the same name (case-insensitive). web_fetch and MCP never send it.
const sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
const safeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), method: String(init?.method ?? "GET"), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200, headers: { "content-type": "application/json" } });
});
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch,
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));
const source = { id: "tsrc_1", key: "down", base_url: "https://down.invalid/api", headers_json: JSON.stringify({ "idempotency-KEY": "configured", "X-Trace": "t" }) };
const toolRow = (method: string) => ({ id: `tool_${method}`, name: method.toLowerCase(), method, path: "/items/{id}", risk_level: "low", read_only: method === "GET" ? 1 : 0, input_schema_json: "{}" });
vi.mock("@forge/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/store")>()),
  repos: {
    unusablePluginResourceIds: async () => ({ agents: new Set(), skills: new Set(), mcp: new Set(), providers: new Set() }),
    getMcpServerByKey: async () => ({ id: "mcp_1", key: "m", url: "https://mcp.invalid/rpc", headers_json: JSON.stringify({ "Idempotency-Key": "mcp-configured" }) }),
    listMcpToolsByServerKey: async () => [{ name: "act", description: "", input_schema_json: "{}", risk_level: "low", read_only: 0 }],
    getToolSourceByKey: async () => source,
    listToolsBySourceKey: async () => ["GET", "POST", "PUT", "PATCH", "DELETE"].map(toolRow),
  },
}));
const { builtinTools, executeOpenApiTool, resolveTools } = await import("@forge/capabilities");

const KEY = "a".repeat(64);
const idemHeaders = (headers: Record<string, string>) => Object.entries(headers).filter(([name]) => name.toLowerCase() === "idempotency-key");

describe("TK-06 downstream Idempotency-Key", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("OpenAPI %s: one Idempotency-Key header, Forge's value replaces the configured one; same on every call", async (method) => {
    sent.length = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executeOpenApiTool({ source, tool: toolRow(method), args: { id: "7" }, idempotencyKey: KEY });
      expect(result.ok).toBe(true);
    }
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.method).toBe(method);
      expect(idemHeaders(request.headers)).toEqual([["Idempotency-Key", KEY]]);
      expect(request.headers["X-Trace"]).toBe("t");
    }
  });

  it("resolveTools: OpenAPI tools pass ToolContext.idempotencyKey through; MCP does not send it", async () => {
    const tools = await resolveTools({ model: { provider: "p", model: "m" }, toolsets: [{ openapi: "down" }, { mcp: "m" }] } as never);
    sent.length = 0;
    await tools.get("openapi_down_post")!.execute({ id: "1" }, { idempotencyKey: KEY });
    expect(idemHeaders(sent[0]!.headers)).toEqual([["Idempotency-Key", KEY]]);
    sent.length = 0;
    await tools.get("mcp_m_act")!.execute({}, { idempotencyKey: KEY });
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(idemHeaders(request.headers).map(([, value]) => value)).not.toContain(KEY);
  });

  it("web_fetch never sends it", async () => {
    sent.length = 0;
    await builtinTools().get("web_fetch")!.execute({ url: "https://page.invalid/" }, { idempotencyKey: KEY });
    expect(sent).toHaveLength(1);
    expect(idemHeaders(sent[0]!.headers)).toEqual([]);
  });
});
