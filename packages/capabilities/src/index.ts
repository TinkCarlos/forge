import {
  config,
  errors,
  ForgeError,
  parseJson,
  type AgentSpec,
  type ToolDefinition,
  type ToolResult,
} from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";

export interface ResolvedTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function toolNameFor(kind: string, source: string, name: string): string {
  const raw = `${kind}_${source}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (raw.length <= 64) return raw;
  const hash = Buffer.from(raw).toString("base64url").slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

function envHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  const object = parseJson<Record<string, unknown>>(raw, {});
  for (const [key, value] of Object.entries(object)) {
    if (typeof value !== "string") continue;
    headers[key] = value.startsWith("env:") ? (process.env[value.slice(4)] ?? "") : value;
  }
  return headers;
}

export function httpToolErrorCode(status: number): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 408 || status === 429 || status >= 500) return "HTP-4002";
  return "HTP-4001";
}

export function privateNetworkBlocked(raw: string): boolean {
  try {
    assertSafeUrl(raw);
    return false;
  } catch {
    return true;
  }
}

function assertSafeUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw errors.tool("仅允许 HTTP/HTTPS 工具地址");
  if (config.TOOL_ALLOW_PRIVATE_NETWORK) return url;
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (privateHost) throw errors.tool(`默认禁止访问私网地址: ${host}`);
  return url;
}

function truncate(text: string, limit = 20000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function builtinTools(): Map<string, ResolvedTool> {
  const map = new Map<string, ResolvedTool>();
  map.set("current_time", {
    definition: {
      name: "current_time",
      description: "Return current UTC time.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      risk: "low",
    },
    execute: async () => ({ ok: true, content: new Date().toISOString() }),
  });
  map.set("echo", {
    definition: {
      name: "echo",
      description: "Echo back the provided text.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      risk: "low",
    },
    execute: async (args) => ({ ok: true, content: String(args.text ?? "") }),
  });
  map.set("web_fetch", {
    definition: {
      name: "web_fetch",
      description: "Fetch a public web page and return readable text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "HTTP/HTTPS URL" } },
        required: ["url"],
        additionalProperties: false,
      },
      risk: "medium",
    },
    execute: async (args) => {
      const url = assertSafeUrl(String(args.url ?? ""));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
        const text = await response.text();
        const content = response.headers.get("content-type")?.includes("html") ? stripHtml(text) : text;
        return { ok: response.ok, content: truncate(content), errorCode: httpToolErrorCode(response.status) };
      } catch (error) {
        return { ok: false, content: `web_fetch failed: ${String(error)}`, errorCode: "HTP-4002" };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return map;
}

export async function discoverMcpTools(server: Record<string, unknown>): Promise<Array<{ name: string; description: string; inputSchema: unknown; risk: string }>> {
  const url = String(server.url);
  const headers = envHeaders(server.headers_json);
  let sessionId: string | null = null;
  const call = async (method: string, params: unknown, id: number | null = null): Promise<Record<string, unknown>> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(config.MCP_TIMEOUT_MS),
    });
    const newSession = response.headers.get("mcp-session-id");
    if (newSession) sessionId = newSession;
    if (!response.ok) throw errors.tool(`MCP ${method} 返回 ${response.status}`);
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.error) throw errors.tool(`MCP ${method} 错误: ${JSON.stringify(payload.error)}`);
      return (payload.result ?? {}) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      // Some MCP servers return SSE frames.
      const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine) {
        const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
        return (payload.result ?? {}) as Record<string, unknown>;
      }
      throw errors.tool("MCP 返回格式无法解析");
    }
  };
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "forge", version: "0.1.0" },
  }, 1);
  await call("notifications/initialized", {}, null).catch(() => ({}));
  const result = await call("tools/list", {}, 2);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.map((raw) => {
    const tool = raw as Record<string, unknown>;
    const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
    const risk = annotations.destructiveHint ? "high" : annotations.readOnlyHint ? "low" : "medium";
    return {
      name: String(tool.name ?? ""),
      description: String(tool.description ?? ""),
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      risk,
    };
  });
}

export async function callMcpTool(server: Record<string, unknown>, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(server.url);
  const headers = envHeaders(server.headers_json);
  let sessionId: string | null = null;
  const rpc = async (method: string, params: unknown, id: number | null): Promise<{ ok: boolean; content: string }> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(config.MCP_TIMEOUT_MS),
    });
    const newSession = response.headers.get("mcp-session-id");
    if (newSession) sessionId = newSession;
    const text = await response.text();
    if (!response.ok) return { ok: false, content: `MCP HTTP ${response.status}` };
    if (!text.trim()) return { ok: true, content: "" };
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload.error) return { ok: false, content: JSON.stringify(payload.error) };
    return { ok: true, content: JSON.stringify(payload.result ?? {}) };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "forge", version: "0.1.0" } }, 1).catch(() => ({}));
  await rpc("notifications/initialized", {}, null).catch(() => ({}));
  const result = await rpc("tools/call", { name: toolName, arguments: args }, 3);
  const parsed = parseJson<Record<string, unknown>>(result.content, {});
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  const text = content
    .map((item) => {
      const block = item as Record<string, unknown>;
      return typeof block.text === "string" ? block.text : JSON.stringify(block);
    })
    .join("\n");
  return {
    ok: result.ok && parsed.isError !== true,
    content: truncate(text || result.content),
    errorCode: result.ok && parsed.isError !== true ? undefined : "MCP-4101",
  };
}

export function parseOpenApi(spec: Record<string, unknown>, fallbackBaseUrl?: string): { baseUrl: string; tools: Array<{ name: string; operationId: string; method: string; path: string; description: string; inputSchema: unknown; risk: string }> } {
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const firstServer = servers[0] as Record<string, unknown> | undefined;
  const baseUrl = fallbackBaseUrl || (typeof firstServer?.url === "string" ? firstServer.url : "");
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const tools: Array<{ name: string; operationId: string; method: string; path: string; description: string; inputSchema: unknown; risk: string }> = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, raw] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const operation = raw as Record<string, unknown>;
      const operationId = String(operation.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`);
      const name = operationId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const rawParam of parameters) {
        const param = rawParam as Record<string, unknown>;
        const paramName = String(param.name ?? "");
        if (!paramName) continue;
        const schema = (param.schema ?? { type: "string" }) as Record<string, unknown>;
        properties[paramName] = { ...schema, description: String(param.description ?? schema.description ?? "") };
        if (param.required) required.push(paramName);
      }
      const requestBody = (operation.requestBody ?? {}) as Record<string, unknown>;
      const content = (requestBody.content ?? {}) as Record<string, Record<string, unknown>>;
      const jsonSchema = content["application/json"]?.schema as Record<string, unknown> | undefined;
      if (jsonSchema && jsonSchema.type === "object") {
        const bodyProps = (jsonSchema.properties ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(bodyProps)) {
          properties[key] = value;
          if (Array.isArray(jsonSchema.required) && jsonSchema.required.includes(key)) required.push(key);
        }
      }
      const risk = method === "delete" || method === "post" || method === "put" || method === "patch" ? "high" : "low";
      tools.push({
        name,
        operationId,
        method: method.toUpperCase(),
        path,
        description: String(operation.description ?? operation.summary ?? `${method.toUpperCase()} ${path}`),
        inputSchema: { type: "object", properties, required },
        risk,
      });
    }
  }
  return { baseUrl, tools };
}

export async function executeOpenApiTool(input: {
  source: Record<string, unknown>;
  tool: Record<string, unknown>;
  args: Record<string, unknown>;
}): Promise<ToolResult> {
  const baseUrl = String(input.source.base_url ?? "");
  const path = String(input.tool.path ?? "");
  const method = String(input.tool.method ?? "GET").toUpperCase();
  const args = { ...input.args };
  const pathParams = path.match(/\{([^}]+)\}/g) ?? [];
  let resolvedPath = path;
  for (const token of pathParams) {
    const name = token.slice(1, -1);
    if (args[name] === undefined) return { ok: false, content: `缺少路径参数: ${name}`, errorCode: "HTP-4001" };
    resolvedPath = resolvedPath.replace(token, encodeURIComponent(String(args[name])));
    delete args[name];
  }
  const url = assertSafeUrl(`${baseUrl.replace(/\/$/, "")}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`);
  const headers = envHeaders(input.source.headers_json);
  let body: string | undefined;
  if (method === "GET" || method === "DELETE" || method === "HEAD") {
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(args);
  }
  try {
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    return {
      ok: response.ok,
      content: truncate(text),
      errorCode: httpToolErrorCode(response.status),
    };
  } catch (error) {
    return { ok: false, content: `openapi tool failed: ${String(error)}`, errorCode: "HTP-4002" };
  }
}

export async function resolveTools(spec: AgentSpec): Promise<Map<string, ResolvedTool>> {
  const tools = new Map<string, ResolvedTool>();
  const builtins = builtinTools();
  for (const toolset of spec.toolsets ?? []) {
    if ("builtin" in toolset) {
      for (const name of toolset.builtin) {
        const tool = builtins.get(name);
        if (tool) tools.set(name, tool);
      }
    }
    if ("mcp" in toolset) {
      const server = await repos.getMcpServerByKey(toolset.mcp);
      if (!server) continue;
      const allowed = toolset.allow;
      const rows = await repos.listMcpToolsByServerKey(toolset.mcp);
      for (const row of rows) {
        const name = String(row.name);
        if (allowed && !allowed.includes(name)) continue;
        const key = toolNameFor("mcp", toolset.mcp, name);
        tools.set(key, {
          definition: {
            name: key,
            description: `[MCP ${toolset.mcp}/${name}] ${String(row.description ?? "")}`,
            parameters: parseJsonValue(row.input_schema_json, { type: "object", properties: {} }),
            risk: (String(row.risk_level) as ToolDefinition["risk"]) ?? "medium",
          },
          execute: async (args) => callMcpTool(server, name, args),
        });
      }
    }
    if ("openapi" in toolset) {
      const source = await repos.getToolSourceByKey(toolset.openapi);
      if (!source) continue;
      const allowed = toolset.allow;
      const rows = await repos.listToolsBySourceKey(toolset.openapi);
      for (const row of rows) {
        const name = String(row.name);
        if (allowed && !allowed.includes(name)) continue;
        const key = toolNameFor("openapi", toolset.openapi, name);
        tools.set(key, {
          definition: {
            name: key,
            description: `[OpenAPI ${toolset.openapi}/${name}] ${String(row.description ?? "")}`,
            parameters: parseJsonValue(row.input_schema_json, { type: "object", properties: {} }),
            risk: String(row.risk_level) as ToolDefinition["risk"],
          },
          execute: async (args) => executeOpenApiTool({ source, tool: row, args }),
        });
      }
    }
  }
  return tools;
}

export { envHeaders, assertSafeUrl, truncate };
