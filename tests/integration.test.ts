import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, encryptSecret, OUTPUT_REPAIR_PREFIX, type Principal } from "@forge/core";
import { createQueuedRun, deliverDueWebhooks, executeRun, idempotencyRequestHash, invokeStatusCode, resolveIdempotentCreate, waitForRun } from "@forge/runtime";
import { execute, one, parseJsonValue, repos } from "@forge/store";

const suffix = Date.now().toString(36);
let agentId = "";
let versionId = "";
let userId = "";
let runId = "";

const admin: Principal = {
  type: "user",
  id: "01J00000000000000000000001",
  name: "Platform Admin",
  role: "platform_admin",
  orgUnitId: "01J00000000000000000000000",
  dataScope: "all",
};

beforeAll(async () => {
  if (!config.DATABASE_URL.includes("forge")) {
    throw new Error("Integration tests require the forge MySQL database");
  }
  agentId = await repos.createAgent({ key: `it-agent-${suffix}`, name: "Integration Agent", ownerOrgUnitId: admin.orgUnitId, createdBy: admin.id });
  versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "You are an integration test assistant.",
    spec: {
      model: { provider: "mock", model: "mock-1" },
      toolsets: [{ builtin: ["current_time"] }],
      limits: { maxSteps: 3, maxCostUsd: 1 },
    },
    status: "published",
    createdBy: admin.id,
  });
  await repos.publishAgentVersion(agentId, versionId);
  const threadId = await repos.createThread({ agentId, orgUnitId: admin.orgUnitId, subjectType: "user", subjectId: admin.id, title: "integration" });
  runId = await repos.createRun({
    threadId,
    agentId,
    agentVersionId: versionId,
    orgUnitId: admin.orgUnitId,
    subjectType: "user",
    subjectId: admin.id,
    input: { text: "hello integration" },
  });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: "hello integration" } });
  userId = await repos.createUser({
    email: `it-self-${suffix}@forge.local`,
    username: `it-self-${suffix}`,
    displayName: "IT Self",
    role: "user",
    dataScope: "self",
    orgUnitId: admin.orgUnitId,
  });
});

afterAll(async () => {
  if (runId) {
    const run = await repos.getRun(runId);
    await execute("DELETE FROM runs WHERE id = ?", [runId]);
    if (run?.thread_id) await execute("DELETE FROM threads WHERE id = ?", [run.thread_id]);
  }
  if (versionId) {
    await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  }
  if (agentId) {
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (userId) {
    await execute("DELETE FROM users WHERE id = ?", [userId]);
  }
});

describe("run runtime", () => {
  it("executes a mock-provider run and persists messages", async () => {
    await executeRun(runId);
    const run = await repos.getRun(runId);
    expect(run?.status).toBe("succeeded");
    const messages = await repos.listMessages(runId);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    const usage = await one<{ count: number }>("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?", [runId]);
    expect(Number(usage?.count ?? 0)).toBeGreaterThan(0);
  });

  it("enforces self data scope", async () => {
    const self = await repos.getUserById(userId);
    expect(self).not.toBeNull();
    const selfPrincipal: Principal = {
      type: "user",
      id: userId,
      name: "IT Self",
      role: "user",
      orgUnitId: admin.orgUnitId,
      dataScope: "self",
    };
    const allRuns = await repos.listRuns({ limit: 100 });
    const selfRuns = await repos.listRuns({ subjectType: "user", subjectId: selfPrincipal.id, limit: 100 });
    expect(allRuns.length).toBeGreaterThan(selfRuns.length);
    expect(selfRuns.every((run) => run.subject_id === selfPrincipal.id)).toBe(true);
  });
});

const created: Array<{ runId: string; threadId: string; versionId: string; agentId: string }> = [];

async function makeRun(spec: Record<string, unknown>, text: string, options: { status?: string; claimedBy?: string | null; leaseSeconds?: number | null } = {}) {
  const agentId = await repos.createAgent({
    key: `rt-${suffix}-${created.length}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Runtime Agent",
    ownerOrgUnitId: admin.orgUnitId,
    createdBy: admin.id,
  });
  const versionId = await repos.createAgentVersion({
    agentId,
    version: "1.0.0",
    instructions: "Answer with the requested tool or JSON.",
    spec,
    status: "published",
    createdBy: admin.id,
  });
  const threadId = await repos.createThread({ agentId, orgUnitId: admin.orgUnitId, subjectType: "user", subjectId: admin.id, title: "runtime" });
  const runId = await repos.createRun({
    threadId,
    agentId,
    agentVersionId: versionId,
    orgUnitId: admin.orgUnitId,
    subjectType: "user",
    subjectId: admin.id,
    input: { text },
    status: options.status,
    claimedBy: options.claimedBy,
    leaseSeconds: options.leaseSeconds,
  });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text } });
  created.push({ runId, threadId, versionId, agentId });
  return runId;
}

afterAll(async () => {
  for (const item of created) {
    await execute("DELETE FROM runs WHERE id = ?", [item.runId]);
    await execute("DELETE FROM threads WHERE id = ?", [item.threadId]);
    await execute("DELETE FROM agent_versions WHERE id = ?", [item.versionId]);
    await execute("DELETE FROM agents WHERE id = ?", [item.agentId]);
  }
});

describe("runtime hardening", () => {
  it("reclaims an expired lease without repeating a succeeded tool", async () => {
    const runId = await makeRun(
      { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }], limits: { maxSteps: 4 } },
      "[use:current_time]",
      { status: "running", claimedBy: "dead-worker", leaseSeconds: 300 },
    );
    const run = await repos.getRun(runId);
    const toolId = await repos.addToolCall({
      runId,
      toolKey: "current_time",
      args: {},
      risk: "low",
      status: "succeeded",
      idempotencyKey: `${runId}:call_mock_0_current_time`,
    });
    await repos.addMessage({
      threadId: run!.thread_id,
      runId,
      seq: 2,
      role: "assistant",
      content: { text: "", tool_calls: [{ id: toolId, type: "function", function: { name: "current_time", arguments: "{}" } }] },
    });
    await repos.addMessage({
      threadId: run!.thread_id,
      runId,
      seq: 3,
      role: "tool",
      content: { text: "2026-10-21T00:00:00.000Z", tool_call_id: toolId, name: "current_time" },
    });
    await repos.addRunStep({ runId, type: "call_model", status: "running", summary: { modelKey: "mock/mock-1" } });
    await repos.expireRunLease(runId);
    await executeRun(runId);
    const finished = await repos.getRun(runId);
    expect(finished?.status).toBe("succeeded");
    const calls = await repos.listToolCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("succeeded");
    const events = await repos.listEvents(runId, 0);
    expect(events.some((event) => event.type === "run.resumed")).toBe(true);
    expect(events.some((event) => event.type === "model.retried")).toBe(true);
  });

  it("lets a second worker claim a run only after the lease expires", async () => {
    const runId = await makeRun({ model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, "lease");
    const first = await repos.claimRun(runId, "worker-a", 60, false);
    const second = await repos.claimRun(runId, "worker-b", 60, false);
    expect(first?.run.claimed_by).toBe("worker-a");
    expect(second).toBeNull();
    await repos.expireRunLease(runId);
    const third = await repos.claimRun(runId, "worker-b", 60, false);
    expect(third?.run.claimed_by).toBe("worker-b");
    expect(third?.previousStatus).toBe("running");
  });

  it("executes two low-risk tools before the next model step", async () => {
    const runId = await makeRun(
      {
        model: { provider: "mock", model: "mock-1" },
        toolsets: [{ builtin: ["current_time", "echo"] }],
        limits: { maxSteps: 4, maxParallelTools: 2 },
      },
      "[use:current_time][use:echo]",
    );
    await executeRun(runId);
    const finished = await repos.getRun(runId);
    expect(finished?.status, `${finished?.error_code ?? ""} ${finished?.error_message ?? ""}`).toBe("succeeded");
    const calls = await repos.listToolCalls(runId);
    expect(calls.map((call) => call.tool_key).sort()).toEqual(["current_time", "echo"]);
    expect(calls.every((call) => call.status === "succeeded")).toBe(true);
    const messages = await repos.listMessages(runId);
    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const finalAssistant = messages.filter((message) => message.role === "assistant").at(-1);
    const finalText = parseJsonValue<{ text?: string }>(finalAssistant?.content_json, {}).text ?? "";
    expect(finalText).toContain("工具执行完成");
  });

  it("streams more than one delta and resumes after Last-Event-ID", async () => {
    const runId = await makeRun({ model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 2 } }, "hello stream");
    await executeRun(runId);
    const events = await repos.listEvents(runId, 0);
    const deltas = events.filter((event) => event.type === "message.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const seqs = deltas.map((event) => Number(event.seq));
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    const first = seqs[0] ?? 0;
    const replay = await repos.listEvents(runId, first);
    expect(replay.some((event) => Number(event.seq) === first)).toBe(false);
    expect(Number(replay[0]?.seq ?? 0)).toBeGreaterThan(first);
  });

  it("repairs invalid structured output and then accepts it", async () => {
    const runId = await makeRun(
      {
        model: { provider: "mock", model: "mock-1" },
        limits: { maxSteps: 4, maxOutputRetries: 2 },
        output: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      },
      "[schema]",
    );
    await executeRun(runId);
    const finished = await repos.getRun(runId);
    expect(finished?.status).toBe("succeeded");
    const output = parseJsonValue<{ json?: { ok?: boolean } }>(finished?.output_json, {});
    expect(output.json?.ok).toBe(true);
    const messages = await repos.listMessages(runId);
    expect(messages.some((message) => parseJsonValue<{ text?: string }>(message.content_json, {}).text?.includes(OUTPUT_REPAIR_PREFIX))).toBe(true);
  });

  it("falls back after the primary mock model returns a retryable error", async () => {
    const provider = await repos.getProviderByKey("mock");
    expect(provider).not.toBeNull();
    const existing = await repos.getModel("mock", "mock-fail");
    if (!existing) {
      await repos.createModel({ providerId: provider!.id, key: "mock-fail", displayName: "Mock fail" });
    }
    const runId = await makeRun(
      {
        model: { provider: "mock", model: "mock-fail", fallbackProvider: "mock", fallbackModel: "mock-1" },
        limits: { maxSteps: 3 },
      },
      "fallback please",
    );
    await executeRun(runId);
    const finished = await repos.getRun(runId);
    expect(finished?.status).toBe("succeeded");
    const events = await repos.listEvents(runId, 0);
    expect(events.some((event) => event.type === "model.retried")).toBe(true);
  });

  it("replays the same idempotency key and rejects a different body", async () => {
    const scope = `idem-${suffix}`;
    let creates = 0;
    const hash = idempotencyRequestHash({ text: "same" });
    const first = await resolveIdempotentCreate({
      scope,
      key: "key-1",
      requestHash: hash,
      create: async () => {
        creates += 1;
        return { statusCode: 202, body: { runId: "run_same", status: "queued" }, runId: "run_same" };
      },
    });
    const replay = await resolveIdempotentCreate({
      scope,
      key: "key-1",
      requestHash: hash,
      create: async () => {
        creates += 1;
        return { statusCode: 202, body: { runId: "run_other" }, runId: "run_other" };
      },
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.runId).toBe("run_same");
    expect(creates).toBe(1);
    await expect(resolveIdempotentCreate({
      scope,
      key: "key-1",
      requestHash: idempotencyRequestHash({ text: "different" }),
      create: async () => ({ statusCode: 202, body: { runId: "run_new" }, runId: "run_new" }),
    })).rejects.toMatchObject({ code: "OPN-4503" });
    await execute("DELETE FROM idempotency_keys WHERE scope = ?", [scope]);
  });

  it("retries a webhook after HTTP 500 and stops on HTTP 400", async () => {
    const appId = await repos.createApiApp({
      key: `wh-${suffix}`,
      name: "Webhook App",
      ownerOrgUnitId: admin.orgUnitId,
      scopes: ["runs:create"],
      webhookUrl: "https://example.com/hooks/forge",
      webhookSecretEncrypted: encryptSecret("whsec_test", config.FORGE_MASTER_KEY),
      createdBy: admin.id,
    });
    await repos.enqueueWebhook({ appId, eventId: "evt_retry", eventType: "run.completed", payload: { id: "evt_retry", type: "run.completed" } });
    await repos.enqueueWebhook({ appId, eventId: "evt_stop", eventType: "run.failed", payload: { id: "evt_stop", type: "run.failed" } });
    let retryCalls = 0;
    await deliverDueWebhooks(async (url, init) => {
      const eventId = (init?.headers as Record<string, string>)["X-Forge-Event-Id"];
      expect(String(url)).toBe("https://example.com/hooks/forge");
      expect(String((init?.headers as Record<string, string>)["X-Forge-Signature"])).toContain("v1=");
      if (eventId === "evt_stop") return new Response("no", { status: 400 });
      retryCalls += 1;
      return new Response(retryCalls === 1 ? "later" : "ok", { status: retryCalls === 1 ? 500 : 200 });
    });
    const firstPass = await repos.listWebhookDeliveries(appId);
    const retryRow = firstPass.find((row) => row.event_id === "evt_retry");
    const stopRow = firstPass.find((row) => row.event_id === "evt_stop");
    expect(retryRow?.status).toBe("pending");
    expect(Number(retryRow?.attempts)).toBe(1);
    expect(stopRow?.status).toBe("failed");
    await execute("UPDATE webhook_deliveries SET next_attempt_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?", [String(retryRow?.id)]);
    await deliverDueWebhooks(async () => new Response("ok", { status: 200 }));
    const secondPass = await repos.listWebhookDeliveries(appId);
    expect(secondPass.find((row) => row.event_id === "evt_retry")?.status).toBe("delivered");
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  });

  it("waits until a run finishes and continues the same thread", async () => {
    const runId = await makeRun({ model: { provider: "mock", model: "mock-1" }, limits: { maxSteps: 4 } }, "first turn");
    const pending = waitForRun(runId, 10);
    await executeRun(runId);
    const waited = await pending;
    expect(waited.timedOut).toBe(false);
    expect(invokeStatusCode(waited.run?.status ?? "")).toBe(200);

    const first = await repos.getRun(runId);
    const followUp = await createQueuedRun({
      agentId: first!.agent_id,
      versionId: first!.agent_version_id,
      principal: admin,
      input: { text: "second turn" },
      threadId: first!.thread_id,
    });
    await executeRun(followUp);
    const messages = await repos.listThreadMessages(first!.thread_id);
    expect(messages.filter((message) => message.run_id === runId).length).toBeGreaterThan(0);
    expect(messages.some((message) => message.run_id === followUp && message.role === "assistant")).toBe(true);
    expect(messages.map((message) => parseJsonValue<{ text?: string }>(message.content_json, {}).text)).toContain("second turn");

    await expect(createQueuedRun({
      agentId: first!.agent_id,
      versionId: first!.agent_version_id,
      principal: { ...admin, id: "01J00000000000000000000099" },
      input: { text: "nope" },
      threadId: first!.thread_id,
    })).rejects.toMatchObject({ code: "RUN-7001" });
    await execute("DELETE FROM runs WHERE id = ?", [followUp]);
  });
});
