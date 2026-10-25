import {
  assertOutboundAllowed,
  config,
  ENV_REF_CODE,
  ENV_REF_MESSAGE,
  isEnvRefError,
  literalHeaders,
  type StoredJsonRef,
  errors,
  ForgeError,
  OUTBOUND_BLOCKED_CODE,
  parseJson,
  safeFetch,
  type AgentSpec,
  type ToolDefinition,
  type ToolResult,
} from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";

/**
 * P3-09: `signal` aborts the call when the worker lost the Run's lease (passed by the runtime).
 * r5 §3.1: `idempotencyKey` is the downstream key of this tool call (same on every attempt and across takeovers); OpenAPI
 * tools send it as `Idempotency-Key`, web_fetch and MCP do not.
 */
export interface ToolContext {
  signal?: AbortSignal;
  idempotencyKey?: string;
}
export interface ResolvedTool {
  definition: ToolDefinition;
  /**
   * r5: true only when the tool is declared read-only; absent/false = has side effects. Kept off ToolDefinition so it is
   * never sent to the model. Snapshotted into tool_calls.read_only when the call is created.
   */
  readOnly?: boolean;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
}

/** A timeout signal, also aborted by the caller's signal when one is given (P3-09). */
function callSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** r5: an OpenAPI operation is read-only only for GET / HEAD. */
export function isReadOnlyHttpMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

/** r5: an MCP tool is read-only only with readOnlyHint === true and destructiveHint !== true (self-reported, see docs). */
export function isReadOnlyMcpTool(annotations: unknown): boolean {
  if (!annotations || typeof annotations !== "object") return false;
  const hints = annotations as Record<string, unknown>;
  return hints.readOnlyHint === true && hints.destructiveHint !== true;
}

function toolNameFor(kind: string, source: string, name: string): string {
  const raw = `${kind}_${source}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (raw.length <= 64) return raw;
  const hash = Buffer.from(raw).toString("base64url").slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

/** Stored headers as literals. AG (S-61): `env:` is no longer expanded; a stored `env:` value throws CFG-8504. */
function envHeaders(raw: unknown, ref?: StoredJsonRef): Record<string, string> {
  return literalHeaders(raw, ref);
}

/** Tool-call shape for a refused `env:` header (no value, no name of the variable). */
function envRefToolResult(error: unknown): ToolResult | null {
  return isEnvRefError(error) ? { ok: false, content: ENV_REF_MESSAGE, errorCode: ENV_REF_CODE } : null;
}

export function httpToolErrorCode(status: number): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 408 || status === 429 || status >= 500) return "HTP-4002";
  return "HTP-4001";
}

/** Tool result for an outbound target refused by the guard (HTP-4003); never echoes the resolved address. */
function blockedToolResult(error: unknown): ToolResult | null {
  if (error instanceof ForgeError && error.code === OUTBOUND_BLOCKED_CODE) return { ok: false, content: error.message, errorCode: OUTBOUND_BLOCKED_CODE };
  return null;
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
    readOnly: true,
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
    readOnly: true,
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
    readOnly: true, // always GET
    execute: async (args, context) => {
      try {
        // Outbound guard (S-46): scheme + DNS check, socket pinned to the checked address, every redirect re-checked.
        const response = await safeFetch(String(args.url ?? ""), { signal: callSignal(15000, context?.signal), redirect: "follow" });
        const text = await response.text();
        const content = response.headers.get("content-type")?.includes("html") ? stripHtml(text) : text;
        return { ok: response.ok, content: truncate(content), errorCode: httpToolErrorCode(response.status) };
      } catch (error) {
        const blocked = blockedToolResult(error);
        if (blocked) return blocked;
        return { ok: false, content: `web_fetch failed: ${String(error)}`, errorCode: "HTP-4002" };
      }
    },
  });
  return map;
}

export async function discoverMcpTools(server: Record<string, unknown>): Promise<Array<{ name: string; description: string; inputSchema: unknown; risk: string; readOnly: boolean }>> {
  const url = String(server.url);
  const headers = envHeaders(server.headers_json, { table: "mcp_servers", column: "headers_json", id: String(server.id) });
  let sessionId: string | null = null;
  const call = async (method: string, params: unknown, id: number | null = null): Promise<Record<string, unknown>> => {
    const response = await safeFetch(url, {
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
      readOnly: isReadOnlyMcpTool(annotations),
    };
  });
}

export async function callMcpTool(server: Record<string, unknown>, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const url = String(server.url);
  let headers: Record<string, string>;
  try {
    headers = envHeaders(server.headers_json, { table: "mcp_servers", column: "headers_json", id: String(server.id) });
  } catch (error) {
    const refused = envRefToolResult(error);
    if (refused) return refused;
    throw error;
  }
  let sessionId: string | null = null;
  try {
    await assertOutboundAllowed(url);
  } catch (error) {
    const blocked = blockedToolResult(error);
    if (blocked) return blocked;
    throw error;
  }
  const rpc = async (method: string, params: unknown, id: number | null): Promise<{ ok: boolean; content: string }> => {
    const response = await safeFetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
      signal: callSignal(config.MCP_TIMEOUT_MS, signal),
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

export function parseOpenApi(spec: Record<string, unknown>, fallbackBaseUrl?: string): { baseUrl: string; tools: Array<{ name: string; operationId: string; method: string; path: string; description: string; inputSchema: unknown; risk: string; readOnly: boolean }> } {
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const firstServer = servers[0] as Record<string, unknown> | undefined;
  const baseUrl = fallbackBaseUrl || (typeof firstServer?.url === "string" ? firstServer.url : "");
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const tools: Array<{ name: string; operationId: string; method: string; path: string; description: string; inputSchema: unknown; risk: string; readOnly: boolean }> = [];
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
        readOnly: isReadOnlyHttpMethod(method),
      });
    }
  }
  return { baseUrl, tools };
}

export async function executeOpenApiTool(input: {
  source: Record<string, unknown>;
  tool: Record<string, unknown>;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  idempotencyKey?: string;
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
  let url: URL;
  try {
    url = (await assertOutboundAllowed(`${baseUrl.replace(/\/$/, "")}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`)).url;
  } catch (error) {
    const blocked = blockedToolResult(error);
    if (blocked) return blocked;
    return { ok: false, content: `openapi tool failed: ${String(error)}`, errorCode: "HTP-4002" };
  }
  let headers: Record<string, string>;
  try {
    headers = envHeaders(input.source.headers_json, { table: "tool_sources", column: "headers_json", id: String(input.source.id) });
  } catch (error) {
    const refused = envRefToolResult(error);
    if (refused) return refused;
    throw error;
  }
  if (input.idempotencyKey) {
    // r5 §3.1: every method; Forge's value replaces a configured header of the same name (any case).
    for (const name of Object.keys(headers)) if (name.toLowerCase() === "idempotency-key") delete headers[name];
    headers["Idempotency-Key"] = input.idempotencyKey;
  }
  let body: string | undefined;
  if (method === "GET" || method === "DELETE" || method === "HEAD") {
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(args);
  }
  try {
    const response = await safeFetch(url, { method, headers, body, signal: callSignal(30000, input.signal) });
    const text = await response.text();
    return {
      ok: response.ok,
      content: truncate(text),
      errorCode: httpToolErrorCode(response.status),
    };
  } catch (error) {
    const blocked = blockedToolResult(error);
    if (blocked) return blocked;
    return { ok: false, content: `openapi tool failed: ${String(error)}`, errorCode: "HTP-4002" };
  }
}

export async function resolveTools(spec: AgentSpec): Promise<Map<string, ResolvedTool>> {
  const tools = new Map<string, ResolvedTool>();
  const builtins = builtinTools();
  // Item A: MCP servers installed by a plugin with an invalid manifest are not loaded (no tools, so no calls either).
  const unusable = (spec.toolsets ?? []).some((toolset) => "mcp" in toolset) ? (await repos.unusablePluginResourceIds()).mcp : new Set<string>();
  for (const toolset of spec.toolsets ?? []) {
    if ("builtin" in toolset) {
      for (const name of toolset.builtin) {
        const tool = builtins.get(name);
        if (tool) tools.set(name, tool);
      }
    }
    if ("mcp" in toolset) {
      const server = await repos.getMcpServerByKey(toolset.mcp);
      if (!server || unusable.has(String(server.id))) continue;
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
          readOnly: Number(row.read_only) === 1,
          execute: async (args, context) => callMcpTool(server, name, args, context?.signal),
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
          readOnly: Number(row.read_only) === 1,
          execute: async (args, context) => executeOpenApiTool({ source, tool: row, args, signal: context?.signal, idempotencyKey: context?.idempotencyKey }),
        });
      }
    }
  }
  return tools;
}

export { envHeaders, truncate };
