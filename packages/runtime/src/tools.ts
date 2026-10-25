import { createHash } from "node:crypto";
import { config, ForgeError, type AgentSpec } from "@forge/core";
import type { ResolvedTool } from "@forge/capabilities";
import { LeaseLostError, parseJsonValue, repos, type RunRow, type ToolCallRow } from "@forge/store";
import { toolCallStarted } from "./drain.js";
import { emit } from "./events.js";
import { appendMessage } from "./messages.js";

type OpenToolCall = ToolCallRow & { approval_status: string | null; approval_reason?: string | null; approval_overdue_s?: number | null };

/** settleToolCalls outcome: go on with a model step, wait (approval pending), or (r5 §2.6) the Run must fail APR-2102. */
export type SettleState = "continue" | "waiting" | "expired";

const REJECTED_MESSAGE = "The user rejected this tool call. Do not retry it; continue with the information available.";
const INTERRUPTED_REJECTED_MESSAGE =
  "The previous execution of this tool call was interrupted and its result is unknown; the user declined to run it again, so it was not retried. Do not retry it; continue with the information available.";
const INTERRUPTED_EXPIRED_MESSAGE =
  "The previous execution of this tool call was interrupted and its result is unknown; the confirmation expired, so it was not retried. Do not retry it; continue with the information available.";

/**
 * Dedup key of one tool call (Q5): the call_model step's run_steps.seq and the call's index in that step's toolCalls.
 * The provider's tool call id is not part of it (providers omit it or repeat it across steps).
 */
/**
 * r5 §3.1 downstream `Idempotency-Key` of a tool call: sha256 hex of `<runId>:<tool_calls.id>`. Depends on the row id only,
 * so it is the same on every attempt and before / after a takeover. Not the tool_calls.idempotency_key column.
 */
export function toolRequestKey(runId: string, toolCallId: string): string {
  return createHash("sha256").update(`${runId}:${toolCallId}`).digest("hex");
}

export function toolIdempotencyKey(runId: string, modelStep: number, stepIndex: number): string {
  return `${runId}:s${modelStep}:${stepIndex}`;
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

/** P3-09: thrown when the worker lost the Run's lease mid-execution; the caller writes nothing more for that Run. */
export { LeaseLostError };
/** P3-09: stop here (write nothing) once the lease signal fired. */
export function assertLeaseHeld(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LeaseLostError();
}

async function executeToolCall(run: RunRow, stored: OpenToolCall, tools: Map<string, ResolvedTool>, signal?: AbortSignal): Promise<void> {
  const tool = tools.get(stored.tool_key);
  const args = parseJsonValue<Record<string, unknown>>(stored.args_json, {});
  // A re-run (running row taken over) or a confirmed re-execution of an interrupted call is the next attempt.
  const again = stored.status === "running" || stored.approval_reason === "interrupted";
  const nextAttempt = again ? Number(stored.attempt ?? 1) + 1 : Number(stored.attempt ?? 1) || 1;
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
  const idempotencyKey = toolRequestKey(run.id, stored.id);
  const executed = await withToolRetries(config.TOOL_MAX_ATTEMPTS, nextAttempt, async () => {
    // Ruling 15:39: a drain releases the lease only after this call has ended (even when it ignores the abort).
    const ended = toolCallStarted(run.id);
    try {
      const outcome = await tool.execute(args, { signal, idempotencyKey });
      assertLeaseHeld(signal); // no retry / tool.retried after an abort
      return outcome;
    } catch (error) {
      assertLeaseHeld(signal);
      const code = error instanceof ForgeError ? error.code : "HTP-4001";
      return { ok: false, content: String(error), errorCode: code === "HTP-4002" || code === "MCP-4102" ? code : "HTP-4001" };
    } finally {
      ended();
    }
  }, async (attempt, failed) => {
    await emit(run.id, "tool.retried", { toolCallId: stored.id, tool: stored.tool_key, attempt, error: failed.errorCode ?? null });
  });
  // P3-09: an execution aborted by lease loss writes no tool result; the next owner re-runs the running call.
  assertLeaseHeld(signal);
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

/**
 * tool.interrupted payload (r5 §2.2): `attempt` is the interrupted attempt; `approvalId` the new interrupted approval
 * (confirm) or null (rerun); `previousApprovalId` the call's earlier approval (never reused), null for a rerun.
 */
function interruptedEvent(stored: OpenToolCall, kind: "rerun" | "confirm", approvalId: string | null): Record<string, unknown> {
  const previousApprovalId = kind === "confirm" ? (stored.approval_id ?? null) : null;
  return { toolCallId: stored.id, tool: stored.tool_key, action: kind, attempt: Number(stored.attempt ?? 1), approvalId, previousApprovalId };
}

/**
 * Settles the Run's open tool calls at the start of a round (and after a model step). r5 takeover (design §2.2): a call
 * still `running` here was left by an interrupted holder. Read-only (snapshot tool_calls.read_only=1) -> re-run in place
 * (attempt + 1). With side effects -> never re-run automatically: a new `interrupted` approval (an earlier approval of
 * that call is never reused), one at a time in created_at order. Expired approvals are rejections and never execute;
 * one expired longer than APPROVAL_EXPIRED_GRACE_SECONDS ago -> approval rejected by the system, call rejected and
 * "expired" (the caller fails the Run with APR-2102, no further model or tool call).
 */
export async function settleToolCalls(run: RunRow, spec: AgentSpec, tools: Map<string, ResolvedTool>, signal?: AbortSignal): Promise<SettleState> {
  await repos.timeoutApprovals(run.id);
  const open: OpenToolCall[] = await repos.listOpenToolCalls(run.id);
  if (!open.length) return "continue";

  const grace = config.APPROVAL_EXPIRED_GRACE_SECONDS;
  const overdue = open.filter((stored) => stored.status === "pending_approval" && stored.approval_status === "expired" && Number(stored.approval_overdue_s ?? 0) > grace);
  if (overdue.length) {
    for (const stored of overdue) {
      if (stored.approval_id) await repos.rejectOverdueApproval(stored.approval_id, run.id);
      await repos.updateToolCall(stored.id, { status: "rejected" });
    }
    return "expired";
  }

  const executable: OpenToolCall[] = [];
  const needsApproval: OpenToolCall[] = [];
  const interrupted: OpenToolCall[] = [];
  let blocked = false;

  for (const stored of open) {
    if (stored.status === "running") {
      if (Number(stored.read_only) === 1) {
        await emit(run.id, "tool.interrupted", interruptedEvent(stored, "rerun", null));
        executable.push(stored);
      } else {
        interrupted.push(stored);
      }
      continue;
    }
    if (stored.status === "pending_approval") {
      if (!stored.approval_status || stored.approval_status === "pending") {
        blocked = true;
        continue;
      }
      if (stored.approval_status === "rejected" || stored.approval_status === "expired") {
        const wasInterrupted = stored.approval_reason === "interrupted";
        const text = !wasInterrupted ? REJECTED_MESSAGE : stored.approval_status === "expired" ? INTERRUPTED_EXPIRED_MESSAGE : INTERRUPTED_REJECTED_MESSAGE;
        await repos.updateToolCall(stored.id, { status: "rejected" });
        await appendMessage(run, "tool", { text, tool_call_id: stored.id, name: stored.tool_key });
        await emit(run.id, "approval.resolved", { approvalId: stored.approval_id, decision: stored.approval_status });
        continue;
      }
      // Invariant: only an `approved` approval makes a pending_approval call executable.
      if (stored.approval_status === "approved") executable.push(stored);
      continue;
    }
    const definition = tools.get(stored.tool_key)?.definition;
    const risk = definition?.risk ?? stored.risk_level;
    if (requiresApproval(stored.tool_key, risk, spec)) needsApproval.push(stored);
    else executable.push(stored);
  }

  const limit = spec.limits?.maxParallelTools ?? config.DEFAULT_MAX_PARALLEL_TOOLS;
  await mapLimit(executable, limit, async (stored) => {
    await executeToolCall(run, stored, tools, signal);
  });

  assertLeaseHeld(signal);
  if (blocked) return "waiting";
  const timeoutSeconds = spec.approval?.timeoutSeconds ?? 3600;
  const cut = interrupted[0];
  if (cut) {
    const definition = tools.get(cut.tool_key)?.definition;
    const risk = definition?.risk ?? cut.risk_level;
    const approval = await repos.addApproval({ runId: run.id, toolCallId: cut.id, risk, timeoutSeconds, reason: "interrupted" });
    await repos.updateRun(run.id, { status: "waiting_approval" });
    await emit(run.id, "tool.interrupted", interruptedEvent(cut, "confirm", approval.id));
    await emit(run.id, "approval.required", { approvalId: approval.id, toolCallId: cut.id, tool: cut.tool_key, risk, reason: "interrupted", expiresAt: approval.expiresAt.toISOString() });
    return "waiting";
  }
  const pending = needsApproval[0];
  if (!pending) return "continue";
  const definition = tools.get(pending.tool_key)?.definition;
  const risk = definition?.risk ?? pending.risk_level;
  const approval = await repos.addApproval({ runId: run.id, toolCallId: pending.id, risk, timeoutSeconds, reason: "policy" });
  await repos.updateRun(run.id, { status: "waiting_approval" });
  await emit(run.id, "approval.required", { approvalId: approval.id, toolCallId: pending.id, tool: pending.tool_key, risk, reason: "policy", expiresAt: approval.expiresAt.toISOString() });
  return "waiting";
}
