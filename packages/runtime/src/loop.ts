import {
  config,
  errors,
  ForgeError,
  type AgentSpec,
  type ChatMessage,
  type Principal,
} from "@forge/core";
import { resolveTools } from "@forge/capabilities";
import { callModel, type LlmResult, type LlmUsage } from "@forge/models";
import { parseJsonValue, repos, type ClaimedRun, type RunRow } from "@forge/store";
import { buildSystemPrompt, compressContext } from "./context.js";
import { emit } from "./events.js";
import { claimRun, currentWorkerId } from "./lease.js";
import { appendMessage, messageOf } from "./messages.js";
import { createDeltaBuffer, decideAfterModelError, modelCandidates } from "./model-loop.js";
import { repairCount, repairMessage, validateOutput } from "./output.js";
import { settleToolCalls, toolIdempotencyKey } from "./tools.js";
import { deliverDueWebhooks, enqueueRunWebhook } from "./webhook.js";

const TERMINAL = ["succeeded", "failed", "cancelled", "budget_exhausted"];

type RunField = { usage: LlmUsage; costUsd: number };

async function addUsage(run: RunRow, usage: LlmUsage): Promise<RunField> {
  const previous = parseJsonValue<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>(run.usage_json, {});
  const next: RunField = {
    usage: {
      inputTokens: Number(previous.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: Number(previous.outputTokens ?? 0) + usage.outputTokens,
      costUsd: Number(previous.costUsd ?? 0) + usage.costUsd,
    },
    costUsd: Number(run.cost_usd ?? 0) + usage.costUsd,
  };
  await repos.updateRun(run.id, { usage: next.usage, costUsd: next.costUsd });
  return next;
}

export async function finalize(
  run: RunRow,
  status: "succeeded" | "failed" | "cancelled" | "budget_exhausted",
  output?: unknown,
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  await repos.updateRun(run.id, {
    status,
    output: output ?? null,
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? null,
    completedAt: new Date(),
  });
  await emit(run.id, `run.${status === "succeeded" ? "completed" : status}`, {
    status,
    output: output ?? null,
    error: errorCode ? { code: errorCode, message: errorMessage ?? "" } : null,
  });
  try {
    await enqueueRunWebhook(run, status);
    await deliverDueWebhooks();
  } catch {
    // Webhook failure must never fail the run.
  }
}

async function runLoop(run: RunRow, workerId: string, lostLease: () => boolean): Promise<void> {
  const agent = await repos.getAgent(run.agent_id);
  if (!agent) throw errors.notFound("Agent 不存在");
  const version = await repos.getAgentVersion(run.agent_version_id);
  if (!version) throw errors.notFound("Agent 版本不存在");
  const spec = parseJsonValue<AgentSpec>(version.spec_json, {
    model: { provider: "mock", model: "mock-1" },
  });
  const tools = await resolveTools(spec);
  const system = await buildSystemPrompt(version.instructions, spec);
  const maxSteps = spec.limits?.maxSteps ?? config.MAX_RUN_STEPS;
  const maxCost = spec.limits?.maxCostUsd ?? config.DEFAULT_MAX_COST_USD;
  const maxOutputRetries = spec.limits?.maxOutputRetries ?? 2;
  const maxContextTokens = spec.limits?.maxContextTokens ?? config.DEFAULT_MAX_CONTEXT_TOKENS;
  const candidates = modelCandidates(spec);

  while (true) {
    if (lostLease()) return;
    const fresh = await repos.getRun(run.id);
    if (!fresh) return;
    if (fresh.claimed_by && fresh.claimed_by !== workerId) return;
    if (TERMINAL.includes(fresh.status)) return;
    if (fresh.cancel_requested) {
      await finalize(fresh, "cancelled");
      return;
    }
    if (Number(fresh.cost_usd ?? 0) >= maxCost) {
      await finalize(fresh, "budget_exhausted", parseJsonValue(fresh.output_json, null), "BUD-5001", "成本预算已耗尽");
      return;
    }

    const openState = await settleToolCalls(fresh, spec, tools);
    if (openState === "waiting") return;

    const historyRows = await repos.listThreadMessages(fresh.thread_id);
    const currentRows = historyRows.filter((row) => row.run_id === fresh.id);
    const assistantCount = currentRows.filter((row) => row.role === "assistant").length;
    if (assistantCount >= maxSteps) {
      await finalize(fresh, "failed", parseJsonValue(fresh.output_json, null), "RUN-7004", `达到最大步数 ${maxSteps}`);
      return;
    }

    const history = historyRows.map((row) => messageOf(row));
    const prepared = compressContext([{ role: "system", content: system }, ...history], maxContextTokens);
    await repos.addRunStep({
      runId: fresh.id,
      type: "prepare_context",
      status: "succeeded",
      summary: { messages: prepared.messages.length, compressed: prepared.compressed },
    });
    if (prepared.compressed) {
      await repos.addRunStep({
        runId: fresh.id,
        type: "compress",
        status: "succeeded",
        summary: { removedMessages: prepared.removedMessages },
      });
      await emit(fresh.id, "context.compressed", { removedMessages: prepared.removedMessages, maxContextTokens });
    }

    const interrupted = await repos.failRunningSteps(fresh.id, "call_model", "MDL-3001");
    if (interrupted > 0) await emit(fresh.id, "model.retried", { reason: "incomplete_step" });

    const messages: ChatMessage[] = prepared.messages;
    let result: LlmResult | null = null;
    let lastError: ForgeError | null = null;
    let index = 0;
    let attempt = 1;
    while (index < candidates.length) {
      const candidate = candidates[index];
      if (!candidate) break;
      const stepId = await repos.addRunStep({
        runId: fresh.id,
        type: "call_model",
        summary: { modelKey: `${candidate.provider}/${candidate.model}`, attempt },
      });
      const deltas = createDeltaBuffer(async (delta) => {
        await emit(fresh.id, "message.delta", { delta });
      });
      try {
        result = await callModel({
          providerKey: candidate.provider,
          modelKey: candidate.model,
          messages,
          tools: [...tools.values()].map((tool) => tool.definition),
          temperature: spec.model.temperature,
          maxTokens: spec.model.maxTokens,
          onDelta: (delta) => deltas.push(delta),
        });
        await deltas.end();
        await repos.finishRunStep(stepId, {
          status: "succeeded",
          summary: { modelKey: `${candidate.provider}/${candidate.model}`, attempt },
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
        });
        lastError = null;
        break;
      } catch (error) {
        await deltas.end();
        const forgeError = error instanceof ForgeError ? error : errors.model(String(error));
        lastError = forgeError;
        await repos.finishRunStep(stepId, {
          status: "failed",
          errorCode: forgeError.code,
          summary: { modelKey: `${candidate.provider}/${candidate.model}`, attempt },
        });
        const decision = decideAfterModelError({
          index,
          attempt,
          maxAttempts: config.MODEL_MAX_ATTEMPTS,
          candidateCount: candidates.length,
          retryable: forgeError.retryable,
        });
        if (decision.kind === "fail") break;
        await emit(fresh.id, "model.retried", {
          provider: candidate.provider,
          model: candidate.model,
          attempt,
          next: decision.kind,
        });
        index = decision.index;
        attempt = decision.attempt;
        result = null;
      }
    }

    if (!result) {
      const forgeError = lastError ?? errors.model("模型调用失败");
      await finalize(fresh, "failed", null, forgeError.code, forgeError.message);
      return;
    }

    const updated = await addUsage(fresh, result.usage);
    const toolCallIds = new Map<string, string>();
    for (const call of result.toolCalls) {
      const definition = tools.get(call.name)?.definition;
      const risk = definition?.risk ?? "medium";
      let args: unknown = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      const rowId = await repos.addToolCall({
        runId: fresh.id,
        toolKey: call.name,
        args,
        risk,
        status: "pending",
        idempotencyKey: toolIdempotencyKey(fresh.id, call.id),
        attempt: 1,
      });
      toolCallIds.set(call.id, rowId);
    }

    const assistantContent: Record<string, unknown> = { text: result.content };
    if (result.toolCalls.length) {
      assistantContent.tool_calls = result.toolCalls.map((call) => ({
        id: toolCallIds.get(call.id) ?? call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    await appendMessage(fresh, "assistant", assistantContent);
    await emit(fresh.id, "message.completed", { text: result.content, usage: result.usage });

    if (updated.costUsd >= maxCost) {
      await finalize(fresh, "budget_exhausted", { text: result.content, usage: updated.usage }, "BUD-5001", "成本预算已耗尽");
      return;
    }

    if (result.toolCalls.length === 0) {
      if (spec.output?.schema) {
        const validation = validateOutput(result.content, spec.output.schema);
        if (!validation.ok) {
          await repos.addRunStep({
            runId: fresh.id,
            type: "validate_output",
            status: "failed",
            summary: { errors: validation.errors },
          });
          const priorRepairs = repairCount(currentRows.filter((row) => row.role === "user").map((row) => messageOf(row).content));
          if (priorRepairs >= maxOutputRetries) {
            await finalize(fresh, "failed", result.content, "OUT-6001", "结构化输出不符合 Schema");
            return;
          }
          await appendMessage(fresh, "user", { text: repairMessage(validation.errors) });
          await emit(fresh.id, "output.rejected", { errors: validation.errors, attempt: priorRepairs + 1 });
          continue;
        }
        await repos.addRunStep({ runId: fresh.id, type: "validate_output", status: "succeeded" });
        await finalize(fresh, "succeeded", { text: result.content, json: validation.value, usage: updated.usage });
        return;
      }
      await finalize(fresh, "succeeded", { text: result.content, usage: updated.usage });
      return;
    }

    const state = await settleToolCalls(fresh, spec, tools);
    if (state === "waiting") return;
  }
}

export async function runClaimed(claimed: ClaimedRun, workerId = currentWorkerId()): Promise<void> {
  const run = claimed.run;
  if (claimed.previousStatus === "queued") {
    await emit(run.id, "run.started", { agentId: run.agent_id, agentVersionId: run.agent_version_id });
  } else if (claimed.previousStatus === "running" || claimed.previousStatus === "waiting_approval") {
    await emit(run.id, "run.resumed", { workerId, previousStatus: claimed.previousStatus });
  }
  const ownership = { lost: false };
  const timer = setInterval(() => {
    void repos.heartbeatRun(run.id, workerId, config.LEASE_TTL_SECONDS).then((ok) => {
      if (!ok) ownership.lost = true;
    }).catch(() => undefined);
  }, Math.max(1000, Math.floor((config.LEASE_TTL_SECONDS * 1000) / 3)));
  try {
    await runLoop(run, workerId, () => ownership.lost);
  } catch (error) {
    if (ownership.lost) return;
    const forgeError = error instanceof ForgeError ? error : new ForgeError("SYS-9001", String(error), 500);
    const fresh = await repos.getRun(run.id);
    if (fresh && !TERMINAL.includes(fresh.status)) {
      await finalize(fresh, "failed", null, forgeError.code, forgeError.message);
    }
  } finally {
    clearInterval(timer);
    await repos.releaseRunLease(run.id, workerId);
  }
}

export async function executeRun(runId: string, workerId = currentWorkerId()): Promise<void> {
  const open = await repos.listOpenToolCalls(runId);
  const allowWaiting = open.some((call) => call.status === "pending_approval" && ["approved", "rejected", "expired"].includes(String(call.approval_status ?? "")));
  const claimed = await claimRun(runId, workerId, allowWaiting);
  if (!claimed) return;
  await runClaimed(claimed, workerId);
}

export async function cancelRun(runId: string): Promise<void> {
  const run = await repos.getRun(runId);
  if (!run) return;
  if (TERMINAL.includes(run.status)) return;
  await repos.requestCancel(runId);
  if (run.status === "queued" || run.status === "waiting_approval") {
    await finalize(run, "cancelled");
  }
}

export async function createQueuedRun(input: {
  agentId: string;
  versionId: string;
  principal: Principal;
  input: unknown;
  appId?: string | null;
  triggerType?: string;
  triggerRef?: string | null;
  threadId?: string | null;
}): Promise<string> {
  const agent = await repos.getAgent(input.agentId);
  if (!agent) throw errors.notFound("Agent 不存在");
  let threadId = input.threadId?.trim() || "";
  if (threadId) {
    const thread = await repos.getThread(threadId);
    const sameSubject = thread && String(thread.agent_id) === input.agentId && String(thread.subject_type) === input.principal.type && String(thread.subject_id) === input.principal.id;
    if (!sameSubject) throw errors.notFound("会话不存在");
  } else {
    threadId = await repos.createThread({
      agentId: input.agentId,
      orgUnitId: input.principal.orgUnitId,
      subjectType: input.principal.type,
      subjectId: input.principal.id,
      title: typeof input.input === "object" && input.input && "text" in input.input ? String((input.input as Record<string, unknown>).text).slice(0, 80) : "",
    });
  }
  const runId = await repos.createRun({
    threadId,
    agentId: input.agentId,
    agentVersionId: input.versionId,
    appId: input.appId ?? null,
    orgUnitId: input.principal.orgUnitId,
    subjectType: input.principal.type,
    subjectId: input.principal.id,
    triggerType: input.triggerType ?? "manual",
    triggerRef: input.triggerRef ?? null,
    input: input.input,
  });
  const text = typeof input.input === "object" && input.input && "text" in input.input ? String((input.input as Record<string, unknown>).text) : String(input.input ?? "");
  await repos.addMessage({
    threadId,
    runId,
    seq: 1,
    role: "user",
    content: { text },
  });
  await emit(runId, "run.queued", { status: "queued" });
  return runId;
}
