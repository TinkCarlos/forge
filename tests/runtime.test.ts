import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@forge/core";
import { httpToolErrorCode } from "@forge/capabilities";
import { consumeOpenAiSse, type OpenAiStreamState } from "@forge/models";
import {
  compressContext,
  createDeltaBuffer,
  decideAfterModelError,
  idempotencyRequestHash,
  clampWaitSeconds,
  invokeStatusCode,
  leaseEligible,
  mapLimit,
  modelCandidates,
  repairMessage,
  toolIdempotencyKey,
  validateOutput,
  webhookRetryDelayMs,
  webhookShouldRetry,
  withToolRetries,
} from "@forge/runtime";

describe("context compression", () => {
  it("keeps the system prompt and recent messages while dropping an oversized older tool result", () => {
    const system: ChatMessage = { role: "system", content: "sys" };
    const oldTool: ChatMessage = { role: "tool", content: "x".repeat(2000), tool_call_id: "old" };
    const recent: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({ role: "user", content: `r${index}` }));
    const result = compressContext([system, oldTool, ...recent], 40, 6);
    expect(result.compressed).toBe(true);
    expect(result.messages[0]?.content).toBe("sys");
    expect(result.messages.at(-1)?.content).toBe("r5");
    expect(result.messages.some((message) => message.content.includes("x".repeat(500)))).toBe(false);
  });
});

describe("model fallback", () => {
  it("retries a candidate before switching to the fallback model", () => {
    const candidates = modelCandidates({
      model: { provider: "mock", model: "mock-fail", fallbackProvider: "mock", fallbackModel: "mock-1" },
    });
    expect(candidates).toEqual([
      { provider: "mock", model: "mock-fail" },
      { provider: "mock", model: "mock-1" },
    ]);
    expect(decideAfterModelError({ index: 0, attempt: 1, maxAttempts: 2, candidateCount: 2, retryable: true })).toEqual({
      kind: "retry",
      index: 0,
      attempt: 2,
    });
    expect(decideAfterModelError({ index: 0, attempt: 2, maxAttempts: 2, candidateCount: 2, retryable: true })).toEqual({
      kind: "fallback",
      index: 1,
      attempt: 1,
    });
    expect(decideAfterModelError({ index: 1, attempt: 2, maxAttempts: 2, candidateCount: 2, retryable: true })).toEqual({ kind: "fail" });
    expect(decideAfterModelError({ index: 0, attempt: 1, maxAttempts: 2, candidateCount: 2, retryable: false })).toEqual({ kind: "fail" });
  });
});

describe("output repair", () => {
  it("rejects invalid JSON and builds a repair prompt", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const invalid = validateOutput("not-json", schema);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(repairMessage(invalid.errors)).toContain("Output validation failed");
    const valid = validateOutput('{"ok":true}', schema);
    expect(valid).toEqual({ ok: true, value: { ok: true } });
  });
});

describe("tool execution", () => {
  it("builds a stable idempotency key and limits parallel execution", async () => {
    expect(toolIdempotencyKey("run_1", "call_1")).toBe("run_1:call_1");
    let inFlight = 0;
    let maxInFlight = 0;
    await mapLimit([1, 2, 3, 4], 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(2);
  });
});

describe("lease eligibility", () => {
  const now = new Date("2026-10-21T00:00:00.000Z");

  it("reclaims only expired or unowned running leases", () => {
    expect(leaseEligible({ status: "queued", claimedBy: null, leaseExpiresAt: null, workerId: "w1", now, allowWaiting: false })).toBe(true);
    expect(leaseEligible({
      status: "running",
      claimedBy: "w1",
      leaseExpiresAt: new Date("2026-10-21T00:01:00.000Z"),
      workerId: "w2",
      now,
      allowWaiting: false,
    })).toBe(false);
    expect(leaseEligible({
      status: "running",
      claimedBy: "w1",
      leaseExpiresAt: new Date("2026-10-20T23:00:00.000Z"),
      workerId: "w2",
      now,
      allowWaiting: false,
    })).toBe(true);
    expect(leaseEligible({ status: "waiting_approval", claimedBy: null, leaseExpiresAt: null, workerId: "w1", now, allowWaiting: false })).toBe(false);
    expect(leaseEligible({ status: "succeeded", claimedBy: null, leaseExpiresAt: null, workerId: "w1", now, allowWaiting: true })).toBe(false);
  });
});

describe("tool and webhook retries", () => {
  it("retries infrastructure tool errors and keeps business errors", async () => {
    expect(httpToolErrorCode(500)).toBe("HTP-4002");
    expect(httpToolErrorCode(404)).toBe("HTP-4001");
    expect(webhookShouldRetry(500)).toBe(true);
    expect(webhookShouldRetry(400)).toBe(false);
    expect(webhookShouldRetry(null)).toBe(true);
    expect(webhookRetryDelayMs(1)).toBe(60_000);
    expect(webhookRetryDelayMs(6)).toBeNull();

    let infraCalls = 0;
    const recovered = await withToolRetries(2, 1, async () => {
      infraCalls += 1;
      return infraCalls === 1 ? { ok: false, errorCode: "HTP-4002" } : { ok: true };
    });
    expect(infraCalls).toBe(2);
    expect(recovered.result.ok).toBe(true);

    let businessCalls = 0;
    const rejected = await withToolRetries(2, 1, async () => {
      businessCalls += 1;
      return { ok: false, errorCode: "HTP-4001" };
    });
    expect(businessCalls).toBe(1);
    expect(rejected.result.ok).toBe(false);
  });

  it("hashes equivalent request bodies to the same idempotency key", () => {
    expect(idempotencyRequestHash({ b: 1, a: { d: 2, c: 3 } })).toBe(idempotencyRequestHash({ a: { c: 3, d: 2 }, b: 1 }));
    expect(idempotencyRequestHash({ a: 1 })).not.toBe(idempotencyRequestHash({ a: 2 }));
  });
});

describe("synchronous invoke", () => {
  it("clamps wait seconds and maps terminal runs to HTTP 200", () => {
    expect(clampWaitSeconds(undefined)).toBe(30);
    expect(clampWaitSeconds("60")).toBe(60);
    expect(clampWaitSeconds(0)).toBe(1);
    expect(clampWaitSeconds(500)).toBe(120);
    expect(clampWaitSeconds("nope")).toBe(30);
    expect(invokeStatusCode("succeeded")).toBe(200);
    expect(invokeStatusCode("failed")).toBe(200);
    expect(invokeStatusCode("running")).toBe(202);
    expect(invokeStatusCode("waiting_approval")).toBe(202);
  });
});

describe("stream deltas", () => {
  it("assembles OpenAI SSE content and splits deltas into ordered chunks", async () => {
    const state: OpenAiStreamState = { content: "", toolCalls: [] };
    const chunks: string[] = [];
    consumeOpenAiSse('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\ndata: [DONE]\n', state, (delta) => chunks.push(delta));
    expect(state.content).toBe("Hello");
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(state.toolCalls[0]).toMatchObject({ id: "call_1", name: "echo" });

    const flushed: string[] = [];
    const buffer = createDeltaBuffer(async (delta) => {
      flushed.push(delta);
    }, 4);
    await buffer.push("abcdefghij");
    await buffer.end();
    expect(flushed).toEqual(["abcd", "efgh", "ij"]);
  });
});
