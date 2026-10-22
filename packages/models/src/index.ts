import {
  config,
  decryptSecret,
  errors,
  ForgeError,
  OUTPUT_REPAIR_PREFIX,
  parseJson,
  type ChatMessage,
  type ToolDefinition,
} from "@forge/core";
import { repos, type ModelRow, type ProviderRow } from "@forge/store";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmResult {
  content: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  raw?: unknown;
}

export interface OpenAiStreamState {
  content: string;
  toolCalls: LlmToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function consumeOpenAiSse(block: string, state: OpenAiStreamState, onContent?: (delta: string) => void): void {
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choice = (Array.isArray(payload.choices) ? payload.choices[0] : undefined) as Record<string, unknown> | undefined;
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      state.content += delta.content;
      onContent?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const item = raw as Record<string, unknown>;
        const index = Number(item.index ?? 0);
        const fn = (item.function ?? {}) as Record<string, unknown>;
        const current = state.toolCalls[index] ?? { id: "", name: "", arguments: "" };
        if (typeof item.id === "string" && item.id) current.id = item.id;
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        state.toolCalls[index] = current;
      }
    }
    if (payload.usage && typeof payload.usage === "object") {
      state.usage = payload.usage as OpenAiStreamState["usage"];
    }
  }
}

function headersFor(provider: ProviderRow): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const extra = parseJson<Record<string, unknown>>(provider.headers_json, {});
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== "string") continue;
    headers[key] = value.startsWith("env:") ? (process.env[value.slice(4)] ?? "") : value;
  }
  if (provider.api_key_encrypted) {
    try {
      headers.Authorization = `Bearer ${decryptSecret(provider.api_key_encrypted, config.FORGE_MASTER_KEY)}`;
    } catch (error) {
      throw new ForgeError("SYS-9002", "Provider 凭据无法解密", 500, error);
    }
  }
  return headers;
}

function usageFor(model: ModelRow, inputTokens: number, outputTokens: number): LlmUsage {
  const inputPrice = Number(model.input_price_per_mtok ?? 0);
  const outputPrice = Number(model.output_price_per_mtok ?? 0);
  return {
    inputTokens,
    outputTokens,
    costUsd: Number(((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000).toFixed(6)),
  };
}

export async function callModel(input: {
  providerKey: string;
  modelKey: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  onDelta?: (delta: string) => void | Promise<void>;
}): Promise<LlmResult> {
  const provider = await repos.getProviderByKey(input.providerKey);
  if (!provider) throw errors.model(`模型供应商不存在: ${input.providerKey}`);
  const model = await repos.getModel(input.providerKey, input.modelKey);
  if (!model) throw errors.model(`模型不存在: ${input.providerKey}/${input.modelKey}`);

  if (provider.protocol === "mock") {
    if (model.key === "mock-fail") throw new ForgeError("MDL-3001", "Mock 模型模拟上游 5xx", 502, undefined, true);
    return mockResult(input.messages, input.tools, model, input.onDelta);
  }
  if (provider.protocol !== "openai-compatible") {
    throw errors.model(`暂不支持协议: ${provider.protocol}`);
  }
  return callOpenAiCompatible(provider, model, input);
}

async function callOpenAiCompatible(
  provider: ProviderRow,
  model: ModelRow,
  input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    onDelta?: (delta: string) => void | Promise<void>;
  },
): Promise<LlmResult> {
  const base = provider.base_url.replace(/\/$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model: model.key,
    messages: input.messages,
    temperature: input.temperature ?? 0.2,
    max_tokens: input.maxTokens ?? model.max_output_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = "auto";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout_ms);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headersFor(provider),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ForgeError("MDL-3001", `模型接口返回 ${response.status}`, 502, text.slice(0, 1000), response.status >= 500 || response.status === 429);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return parseOpenAiJson(await response.text(), model, input.onDelta);
    }
    const state: OpenAiStreamState = { content: "", toolCalls: [] };
    const reader = response.body?.getReader();
    if (!reader) throw new ForgeError("MDL-3003", "模型没有返回流", 502);
    const decoder = new TextDecoder();
    let buffer = "";
    const apply = async (block: string): Promise<void> => {
      const deltas: string[] = [];
      consumeOpenAiSse(block, state, (delta) => deltas.push(delta));
      for (const delta of deltas) await input.onDelta?.(delta);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) await apply(part);
    }
    if (buffer.trim()) await apply(buffer);
    const toolCalls = state.toolCalls.flatMap((call, index) => {
      if (!call?.name) return [];
      return [{ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" }];
    });
    const usage = state.usage
      ? usageFor(model, Number(state.usage.prompt_tokens ?? 0), Number(state.usage.completion_tokens ?? 0))
      : usageFor(model, Math.ceil(JSON.stringify(input.messages).length / 4), Math.ceil(state.content.length / 4));
    return { content: state.content, toolCalls, usage };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ForgeError("MDL-3004", "模型调用超时", 504, undefined, true);
    }
    throw new ForgeError("MDL-3001", "模型调用失败", 502, String(error), true);
  } finally {
    clearTimeout(timeout);
  }
}

async function emitContent(content: string, onDelta?: (delta: string) => void | Promise<void>): Promise<void> {
  if (!onDelta || !content) return;
  const size = 24;
  for (let index = 0; index < content.length; index += size) {
    await onDelta(content.slice(index, index + size));
  }
}

function parseOpenAiJson(text: string, model: ModelRow, onDelta?: (delta: string) => void | Promise<void>): Promise<LlmResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ForgeError("MDL-3003", "模型返回不是合法 JSON", 502, text.slice(0, 500));
  }
  const choice = (Array.isArray(payload.choices) ? payload.choices[0] : undefined) as Record<string, unknown> | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const toolCalls: LlmToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((raw, index) => {
        const item = raw as Record<string, unknown>;
        const fn = (item.function ?? {}) as Record<string, unknown>;
        return {
          id: typeof item.id === "string" ? item.id : `call_${index}`,
          name: String(fn.name ?? ""),
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        };
      })
    : [];
  const usageRaw = (payload.usage ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";
  return emitContent(content, onDelta).then(() => ({
    content,
    toolCalls,
    usage: usageFor(model, Number(usageRaw.prompt_tokens ?? 0), Number(usageRaw.completion_tokens ?? 0)),
    raw: payload,
  }));
}

async function mockResult(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  model: ModelRow,
  onDelta?: (delta: string) => void | Promise<void>,
): Promise<LlmResult> {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const content = lastUser?.content ?? "";
  const lastMessage = messages[messages.length - 1];
  const askedSchema = messages.some((message) => message.role === "user" && message.content.includes("[schema]"));
  const repairing = messages.some((message) => message.role === "user" && message.content.includes(OUTPUT_REPAIR_PREFIX));
  if (askedSchema && lastMessage?.role === "user") {
    const text = repairing ? '{"ok":true}' : "not-json";
    await emitContent(text, onDelta);
    return { content: text, toolCalls: [], usage: usageFor(model, Math.ceil(content.length / 4), text.length) };
  }
  const uses = [...content.matchAll(/\[use:([a-zA-Z0-9_:\-/]+)\]/g)].map((match) => match[1]!).filter((name) => tools.some((tool) => tool.name === name));
  if (lastMessage?.role === "user" && uses.length > 0 && uses.length === [...content.matchAll(/\[use:([a-zA-Z0-9_:\-/]+)\]/g)].length) {
    return {
      content: "",
      toolCalls: uses.map((name, index) => ({
        id: `call_mock_${index}_${name}`,
        name,
        arguments: name === "echo" ? JSON.stringify({ text: "hi" }) : "{}",
      })),
      usage: usageFor(model, Math.ceil(content.length / 4), 10),
    };
  }
  const hasToolResult = messages.some((message) => message.role === "tool");
  const prefix = hasToolResult ? "工具执行完成。" : "";
  const text = `${prefix}Forge 演示助手已收到：${content || "（空输入）"}\n\n这是离线 Mock 模型返回；在控制台配置任意 OpenAI-compatible Provider 后即可使用真实模型。`;
  await emitContent(text, onDelta);
  return {
    content: text,
    toolCalls: [],
    usage: usageFor(model, Math.ceil((content.length + 40) / 4), 64),
  };
}
