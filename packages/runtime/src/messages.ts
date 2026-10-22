import { ForgeError, type ChatMessage } from "@forge/core";
import { isRetryableWrite, parseJsonValue, repos, type MessageRow, type RunRow } from "@forge/store";

export function messageOf(row: MessageRow): ChatMessage {
  const content = parseJsonValue<Record<string, unknown>>(row.content_json, {});
  const base: ChatMessage = {
    role: row.role as ChatMessage["role"],
    content: typeof content.text === "string" ? content.text : "",
  };
  if (Array.isArray(content.tool_calls)) base.tool_calls = content.tool_calls as ChatMessage["tool_calls"];
  if (typeof content.tool_call_id === "string") base.tool_call_id = content.tool_call_id;
  if (typeof content.name === "string") base.name = content.name;
  return base;
}

export async function appendMessage(run: RunRow, role: string, content: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seq = await repos.nextMessageSeq(run.id);
    try {
      return await repos.addMessage({ threadId: run.thread_id, runId: run.id, seq, role, content });
    } catch (error) {
      if (!isRetryableWrite(error)) throw error;
    }
  }
  throw new ForgeError("SYS-9001", "消息序号分配失败", 500);
}
