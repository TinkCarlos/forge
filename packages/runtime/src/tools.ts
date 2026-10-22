import { config, ForgeError, type AgentSpec } from "@forge/core";
import type { ResolvedTool } from "@forge/capabilities";
import { parseJsonValue, repos, type RunRow, type ToolCallRow } from "@forge/store";
import { emit } from "./events.js";
import { appendMessage } from "./messages.js";

type OpenToolCall = ToolCallRow & { approval_status: string | null };

export function toolIdempotencyKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`.slice(0, 191);
}

export function requiresApproval(toolKey: string, risk: string, spec: AgentSpec): boolean {
  return risk === "high" || (spec.approval?.tools ?? []).includes(toolKey);
}

const RETRYABLE_TOOL_CODES = new Set(["HTP-4002", "MCP-4102"]);

export function toolFailureRetryable(errorCode: string | undefined): boolean {
  return Boolean(errorCode && RETRYABLE_TOOL_CODES.has(errorCode));
}

export function nextToolAttempt(attempt: number, maxAttempts: number, retryable: boolean): "retry" | "fail" {
  if (!retryable || attempt >= maxAttempts) return "fail";
  return "retry";
}

export async function withToolRetries<T extends { ok: boolean; errorCode?: string }>(
  maxAttempts: number,
  startAttempt: number,
  run: (attempt: number) => Promise<T>,
  onRetry?: (attempt: number, result: T) => Promise<void>,
): Promise<{ result: T; attempt: number }> {
  let attempt = Math.max(1, startAttempt);
  let tries = 0;
  while (tries < maxAttempts) {
    tries += 1;
    const result = await run(attempt);
    const canRetry = tries < maxAttempts && toolFailureRetryable(result.errorCode);
    if (result.ok || !canRetry) return { result, attempt };
    await onRetry?.(attempt, result);
    attempt += 1;
  }
  throw new ForgeError("HTP-4002", "工具重试次数已耗尽", 502, undefined, true);
}

export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function executeToolCall(run: RunRow, stored: OpenToolCall, tools: Map<string, ResolvedTool>): Promise<void> {
  const tool = tools.get(stored.tool_key);
  const args = parseJsonValue<Record<string, unknown>>(stored.args_json, {});
  const nextAttempt = stored.status === "running" ? Number(stored.attempt ?? 1) + 1 : Number(stored.attempt ?? 1) || 1;
  const stepId = await repos.addRunStep({
    runId: run.id,
    type: "execute_tool",
    toolCallId: stored.id,
    summary: { tool: stored.tool_key, attempt: nextAttempt },
  });
  if (!tool) {
    await repos.updateToolCall(stored.id, { status: "failed", errorCode: "HTP-4001", attempt: nextAttempt });
    await appendMessage(run, "tool", { text: `Tool not available: ${stored.tool_key}`, tool_call_id: stored.id, name: stored.tool_key });
    await emit(run.id, "tool.failed", { toolCallId: stored.id, tool: stored.tool_key, error: "TOOL_NOT_FOUND" });
    await repos.finishRunStep(stepId, { status: "failed", errorCode: "HTP-4001" });
    return;
  }
  await repos.updateToolCall(stored.id, { status: "running", attempt: nextAttempt });
  await emit(run.id, "tool.started", { toolCallId: stored.id, tool: stored.tool_key, risk: stored.risk_level });
  const started = Date.now();
  const executed = await withToolRetries(config.TOOL_MAX_ATTEMPTS, nextAttempt, async () => {
    try {
      return await tool.execute(args);
    } catch (error) {
      const code = error instanceof ForgeError ? error.code : "HTP-4001";
      return { ok: false, content: String(error), errorCode: code === "HTP-4002" || code === "MCP-4102" ? code : "HTP-4001" };
    }
  }, async (attempt, failed) => {
    await emit(run.id, "tool.retried", { toolCallId: stored.id, tool: stored.tool_key, attempt, error: failed.errorCode ?? null });
  });
  const result = executed.result;
  const durationMs = Date.now() - started;
  await repos.updateToolCall(stored.id, {
    status: result.ok ? "succeeded" : "failed",
    result,
    resultText: result.content.slice(0, 20000),
    errorCode: result.errorCode ?? null,
    attempt: executed.attempt,
  });
  await appendMessage(run, "tool", {
    text: result.content.slice(0, 20000),
    tool_call_id: stored.id,
    name: stored.tool_key,
  });
  await emit(run.id, result.ok ? "tool.completed" : "tool.failed", {
    toolCallId: stored.id,
    tool: stored.tool_key,
    durationMs,
    error: result.ok ? null : result.errorCode,
  });
  await repos.finishRunStep(stepId, { status: result.ok ? "succeeded" : "failed", errorCode: result.errorCode ?? null });
}

export async function settleToolCalls(run: RunRow, spec: AgentSpec, tools: Map<string, ResolvedTool>): Promise<"continue" | "waiting"> {
  await repos.timeoutApprovals(run.id);
  const open = await repos.listOpenToolCalls(run.id);
  if (!open.length) return "continue";

  const executable: OpenToolCall[] = [];
  const needsApproval: OpenToolCall[] = [];
  let blocked = false;

  for (const stored of open) {
    if (stored.status === "running") {
      executable.push(stored);
      continue;
    }
    if (stored.status === "pending_approval") {
      if (!stored.approval_status || stored.approval_status === "pending") {
        blocked = true;
        continue;
      }
      if (stored.approval_status === "rejected" || stored.approval_status === "expired") {
        await repos.updateToolCall(stored.id, { status: "rejected" });
        await appendMessage(run, "tool", {
          text: "The user rejected this tool call. Do not retry it; continue with the information available.",
          tool_call_id: stored.id,
          name: stored.tool_key,
        });
        await emit(run.id, "approval.resolved", { approvalId: stored.approval_id, decision: stored.approval_status });
        continue;
      }
      executable.push(stored);
      continue;
    }
    const definition = tools.get(stored.tool_key)?.definition;
    const risk = definition?.risk ?? stored.risk_level;
    if (requiresApproval(stored.tool_key, risk, spec)) needsApproval.push(stored);
    else executable.push(stored);
  }

  const limit = spec.limits?.maxParallelTools ?? config.DEFAULT_MAX_PARALLEL_TOOLS;
  await mapLimit(executable, limit, async (stored) => {
    await executeToolCall(run, stored, tools);
  });

  if (blocked) return "waiting";
  const pending = needsApproval[0];
  if (!pending) return "continue";
  const definition = tools.get(pending.tool_key)?.definition;
  const risk = definition?.risk ?? pending.risk_level;
  const approvalId = await repos.addApproval({
    runId: run.id,
    toolCallId: pending.id,
    risk,
    timeoutSeconds: spec.approval?.timeoutSeconds ?? 3600,
  });
  await repos.updateRun(run.id, { status: "waiting_approval" });
  await emit(run.id, "approval.required", { approvalId, toolCallId: pending.id, tool: pending.tool_key, risk });
  return "waiting";
}
