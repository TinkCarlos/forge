import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

// Q5 (design §3.2, rulings 13:15 / 13:22). The provider's tool call id is never a key and is never replayed: a provider
// that omits ids (models fell back to `call_${index}` for every step) or repeats one id used to make addToolCall return
// the earlier row, so later calls were neither stored nor executed while the Run still succeeded. Now a row is unique
// per (run_id, model_step = run_steps.seq of the call_model step, step_index = index in that step's toolCalls), the
// dedup key is `<runId>:s<model_step>:<step_index>`, call_id keeps the provider id for audit only, and every request to
// the model carries only our own `tcl_` row ids, unique, each answered by exactly one tool message.
// Only the network edge (safeFetch) is stubbed; DB, runtime and models are real.
const safeFetch = vi.fn();
vi.mock("@forge/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@forge/core")>()), safeFetch }));

const { execute, query, repos } = await import("@forge/store");
const { executeRun } = await import("@forge/runtime");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `q5-${suffix}`;
let agentId = "";
let versionId = "";
let providerId = "";

type Call = { id?: string; type: "function"; function: { name: string; arguments: string } };
const echoCall = (text: string, id?: string): Call => ({ ...(id === undefined ? {} : { id }), type: "function", function: { name: "echo", arguments: JSON.stringify({ text }) } });

type SentMessage = { role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
type Row = { id: string; status: string; tool_key: string; idempotency_key: string | null; result_text: string | null; call_id: string | null; model_step: number | null; step_index: number | null; attempt: number };

function sentMessages(index: number): SentMessage[] {
  const init = safeFetch.mock.calls[index]?.[1] as RequestInit | undefined;
  return init ? (JSON.parse(String(init.body)).messages as SentMessage[]) : [];
}

/**
 * Every request we sent: the only tool call ids are `tcl_` row ids of this Run (never a provider id), assistant
 * tool_call ids are unique and each has exactly one tool reply carrying the same row id.
 */
function expectWellFormedRequests(rowIds: string[], providerIds: string[] = []): void {
  const rows = new Set(rowIds);
  for (let index = 0; index < safeFetch.mock.calls.length; index += 1) {
    const sent = sentMessages(index);
    const callIds = sent.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
    const replyIds = sent.flatMap((m) => (m.role === "tool" ? [m.tool_call_id ?? ""] : []));
    for (const id of [...callIds, ...replyIds]) expect(id, `tool call id ${id} in a model request`).toMatch(/^tcl_/);
    expect(new Set(callIds).size).toBe(callIds.length);
    for (const id of callIds) {
      expect(rows.has(id), `replayed id ${id} is a tool_calls row id`).toBe(true);
      expect(providerIds).not.toContain(id);
      expect(replyIds.filter((reply) => reply === id)).toHaveLength(1);
    }
    for (const id of replyIds) expect(rows.has(id)).toBe(true);
  }
}

function jsonResponse(message: { content?: string; tool_calls?: Call[] }): Response {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(message: { content?: string; tool_calls?: Call[] }): Response {
  const chunks: string[] = [];
  if (message.content) chunks.push(JSON.stringify({ choices: [{ delta: { content: message.content } }] }));
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    chunks.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, ...(call.id === undefined ? {} : { id: call.id }), type: "function", function: call.function }] } }] }));
  }
  const body = `${chunks.map((c) => `data: ${c}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function newRun(): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  return repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" } });
}

const rowsOf = (runId: string) =>
  query<Row>("SELECT id, status, tool_key, idempotency_key, result_text, call_id, model_step, step_index, attempt FROM tool_calls WHERE run_id = ? ORDER BY model_step IS NULL DESC, model_step, step_index, created_at", [runId]);
const modelSteps = async (runId: string) =>
  (await query<{ seq: number }>("SELECT seq FROM run_steps WHERE run_id = ? AND type = 'call_model' ORDER BY seq", [runId])).map((row) => Number(row.seq));

beforeAll(async () => {
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "Q5 stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  agentId = await repos.createAgent({ key: `it-q5-${suffix}`, name: "IT Q5", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "x",
    spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [{ builtin: ["echo"] }] },
    status: "published",
    createdBy: ADMIN_ID,
  }, { expectedRevision: "system" });
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (agentId) {
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
});

describe("Q5: tool call identity is ours, never the provider's", () => {
  it.each([
    ["JSON response", jsonResponse],
    ["SSE stream", sseResponse],
  ] as const)("Q5-01/02 %s: id-less calls in two steps are both stored and executed; requests carry only row ids", async (_label, respond) => {
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(respond({ content: "", tool_calls: [echoCall("one")] }))
      .mockResolvedValueOnce(respond({ content: "", tool_calls: [echoCall("two")] }))
      .mockResolvedValueOnce(respond({ content: "done" }))
      .mockResolvedValue(respond({ content: "done (extra)" }));
    const runId = await newRun();
    await executeRun(runId, `w-q5-${suffix}`);

    const run = await repos.getRun(runId);
    const calls = await rowsOf(runId);
    const steps = await modelSteps(runId);
    expect(run?.status).toBe("succeeded");
    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(steps).toHaveLength(3);
    expect(calls.map((c) => [c.model_step, c.step_index, c.call_id, c.result_text, c.status])).toEqual([
      [steps[0], 0, null, "one", "succeeded"],
      [steps[1], 0, null, "two", "succeeded"],
    ]);
    expect(steps[0]!).toBeLessThan(steps[1]!);
    expect(calls.map((c) => c.idempotency_key)).toEqual([`${runId}:s${steps[0]}:0`, `${runId}:s${steps[1]}:0`]);
    // The final request replays both calls, in order, with the row ids.
    const replayed = sentMessages(2).flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
    expect(replayed).toEqual(calls.map((c) => c.id));
    expectWellFormedRequests(calls.map((c) => c.id), ["call_0"]);
  });

  it("Q5-03 provider returns the same id every step (and twice within a step): every call is stored and executed", async () => {
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("a", "x"), echoCall("b", "x")] }))
      .mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("c", "x")] }))
      .mockResolvedValueOnce(jsonResponse({ content: "done" }))
      .mockResolvedValue(jsonResponse({ content: "done (extra)" }));
    const runId = await newRun();
    await executeRun(runId, `w-q5-${suffix}`);
    const run = await repos.getRun(runId);
    const calls = await rowsOf(runId);
    const steps = await modelSteps(runId);
    expect(run?.status).toBe("succeeded");
    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => [c.model_step, c.step_index, c.call_id, c.result_text, c.status])).toEqual([
      [steps[0], 0, "x", "a", "succeeded"],
      [steps[0], 1, "x", "b", "succeeded"],
      [steps[1], 0, "x", "c", "succeeded"],
    ]);
    // Step 1 returned two calls both with id "x": its assistant message carries the two distinct row ids, in order.
    const perStep = sentMessages(2).filter((m) => m.role === "assistant" && m.tool_calls?.length).map((m) => (m.tool_calls ?? []).map((t) => t.id));
    expect(perStep).toEqual([calls.slice(0, 2).map((c) => c.id), calls.slice(2).map((c) => c.id)]);
    expectWellFormedRequests(calls.map((c) => c.id), ["x"]);
  });

  it("Q5-04 odd provider ids (empty, over 191 chars, row-id-like, call_0 / fallback_ / dup_) never affect storing or replay", async () => {
    const long = `p${"z".repeat(199)}`;
    const runId = await newRun();
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("e", ""), echoCall("l", long), echoCall("c0", "call_0"), echoCall("f", "fallback_s1_0"), echoCall("d", "dup_s1_0")] }))
      .mockImplementationOnce(async () => {
        // Step 2 reuses, as its provider id, the row id of the first call stored in step 1.
        const [first] = await rowsOf(runId);
        return jsonResponse({ content: "", tool_calls: [echoCall("r", first?.id ?? "missing")] });
      })
      .mockResolvedValueOnce(jsonResponse({ content: "done" }))
      .mockResolvedValue(jsonResponse({ content: "done (extra)" }));
    await executeRun(runId, `w-q5-${suffix}`);
    const run = await repos.getRun(runId);
    const calls = await rowsOf(runId);
    expect(run?.status).toBe("succeeded");
    expect(calls).toHaveLength(6);
    expect(calls.map((c) => c.result_text)).toEqual(["e", "l", "c0", "f", "d", "r"]);
    expect(calls.every((c) => c.status === "succeeded")).toBe(true);
    expect(calls.map((c) => c.call_id)).toEqual([null, long.slice(0, 191), "call_0", "fallback_s1_0", "dup_s1_0", calls[0]!.id]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(6);
    const perStep = sentMessages(2).filter((m) => m.role === "assistant" && m.tool_calls?.length).map((m) => (m.tool_calls ?? []).map((t) => t.id));
    expect(perStep).toEqual([calls.slice(0, 5).map((c) => c.id), [calls[5]!.id]]);
    expectWellFormedRequests(calls.map((c) => c.id), ["", long, "call_0", "fallback_s1_0", "dup_s1_0"]);
  });

  it("Q5-05 a takeover after the calls were stored keeps row id, key, model_step / step_index; the call runs once", async () => {
    const runId = await newRun();
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("t", "x")] }))
      .mockResolvedValueOnce(jsonResponse({ content: "done" }))
      .mockResolvedValue(jsonResponse({ content: "done (extra)" }));
    // The first worker loses its lease right after the assistant message (calls stored, still pending, not executed).
    const original = repos.addMessage.bind(repos);
    const spy = vi.spyOn(repos, "addMessage").mockImplementation(async (input) => {
      const id = await original(input);
      if (input.role === "assistant") await execute("UPDATE runs SET claimed_by = 'q5-thief' WHERE id = ?", [runId]);
      return id;
    });
    try {
      await executeRun(runId, `w-q5-old-${suffix}`);
    } finally {
      spy.mockRestore();
    }
    const before = await rowsOf(runId);
    expect(before.map((c) => c.status)).toEqual(["pending"]);
    await repos.expireRunLease(runId, "q5-thief");
    await executeRun(runId, `w-q5-new-${suffix}`);
    const after = await rowsOf(runId);
    const pick = (c: Row) => [c.id, c.idempotency_key, c.model_step, c.step_index, c.call_id];
    expect(after.map(pick)).toEqual(before.map(pick));
    expect(after.map((c) => [c.status, c.attempt, c.result_text])).toEqual([["succeeded", 1, "t"]]);
    const started = await query<{ n: number }>("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'tool.started'", [runId]);
    expect(Number(started[0]?.n)).toBe(1);
    expect((await repos.getRun(runId))?.status).toBe("succeeded");
    expectWellFormedRequests(after.map((c) => c.id), ["x"]);
  });

  it("Q5-06 addToolCall: same (run, model_step, step_index) and tool -> the existing row; another tool -> SYS-9001", async () => {
    const runId = await newRun();
    const key = `${runId}:s7:0`;
    const first = await repos.addToolCall({ runId, toolKey: "echo", args: {}, risk: "low", status: "pending", idempotencyKey: key, modelStep: 7, stepIndex: 0 });
    const again = await repos.addToolCall({ runId, toolKey: "echo", args: { other: 1 }, risk: "low", status: "pending", idempotencyKey: key, modelStep: 7, stepIndex: 0 });
    expect(again).toBe(first);
    await expect(repos.addToolCall({ runId, toolKey: "web_fetch", args: {}, risk: "low", status: "pending", idempotencyKey: key, modelStep: 7, stepIndex: 0 }))
      .rejects.toMatchObject({ code: "SYS-9001", message: "工具调用记录冲突", httpStatus: 500 });
    expect(await rowsOf(runId)).toHaveLength(1);
  });

  it("Q5-06/07 a stored row already holding the new key with another tool (e.g. a pre-1.3 row) fails the Run with SYS-9001", async () => {
    const runId = await newRun();
    // Fresh Run: prepare_context is run_steps.seq 1, the first call_model is seq 2.
    await execute("INSERT INTO tool_calls (id, run_id, tool_key, args_json, status, risk_level, idempotency_key) VALUES (?, ?, 'legacy_tool', '{}', 'succeeded', 'low', ?)", [`tcl_q5old${randomBytes(4).toString("hex")}`.slice(0, 26), runId, `${runId}:s2:0`]);
    safeFetch.mockReset();
    safeFetch.mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("n")] })).mockResolvedValue(jsonResponse({ content: "done" }));
    await executeRun(runId, `w-q5-${suffix}`);
    const run = await repos.getRun(runId);
    expect(await modelSteps(runId)).toEqual([2]);
    expect(run?.status).toBe("failed");
    expect(run?.error_code).toBe("SYS-9001");
    expect(run?.error_message).toBe("工具调用记录冲突");
    expect((await rowsOf(runId)).map((c) => c.tool_key)).toEqual(["legacy_tool"]);
  });

  it("Q5-07 pre-1.3 rows (NULL model_step / step_index / call_id, key <run>:call_0) do not affect new steps and replay by row id", async () => {
    const runId = await newRun();
    const run0 = await repos.getRun(runId);
    const oldId = `tcl_q5legacy${randomBytes(4).toString("hex")}`.slice(0, 26);
    await execute("INSERT INTO tool_calls (id, run_id, tool_key, args_json, status, risk_level, idempotency_key, result_text) VALUES (?, ?, 'echo', '{\"text\":\"old\"}', 'succeeded', 'low', ?, 'old')", [oldId, runId, `${runId}:call_0`]);
    await repos.addMessage({ threadId: run0!.thread_id, runId, seq: 1, role: "assistant", content: { text: "", tool_calls: [{ id: oldId, type: "function", function: { name: "echo", arguments: "{\"text\":\"old\"}" } }] } });
    await repos.addMessage({ threadId: run0!.thread_id, runId, seq: 2, role: "tool", content: { text: "old", tool_call_id: oldId, name: "echo" } });
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(jsonResponse({ content: "", tool_calls: [echoCall("new")] }))
      .mockResolvedValueOnce(jsonResponse({ content: "done" }))
      .mockResolvedValue(jsonResponse({ content: "done (extra)" }));
    await executeRun(runId, `w-q5-${suffix}`);
    const calls = await rowsOf(runId);
    expect((await repos.getRun(runId))?.status).toBe("succeeded");
    expect(calls.map((c) => [c.id === oldId, c.model_step === null, c.call_id, c.result_text, c.status])).toEqual([
      [true, true, null, "old", "succeeded"],
      [false, false, null, "new", "succeeded"],
    ]);
    expect(calls[0]!.idempotency_key).toBe(`${runId}:call_0`);
    const replayed = sentMessages(1).flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
    expect(replayed).toEqual([oldId, calls[1]!.id]);
    expectWellFormedRequests(calls.map((c) => c.id));
  });
});
