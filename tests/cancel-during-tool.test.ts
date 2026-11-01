import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// r6 baseline bug: a cancel accepted (200) while an approved tool call executes was ignored; after the tool the loop
// went on to the model and the Run ended succeeded. Contract (architect, 10:13): cancel of a Run that has not finished
// is accepted (200, body unchanged) and takes effect once the current tool call has ended (no forced interruption):
// the call completes once and the Run ends cancelled. The approval is decided directly (repos.decideApproval) and the
// Run executed in this process, so only the cancel goes through the route. The model's network edge is stubbed
// (safeFetch answers "done"). *_test DB only.
const KEY = vi.hoisted(() => `cdt${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`);
/** Long enough that the cancel surely lands while the tool executes, even on a loaded machine. */
const HANG_MS = 1500;
vi.mock("@forge/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@forge/core")>()),
  safeFetch: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })),
  assertOutboundAllowed: async (raw: string | URL) => ({ url: new URL(String(raw)), addresses: [], allowlisted: true }),
}));
vi.mock("@forge/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forge/capabilities")>();
  const { hangingTools } = await import("./helpers/hanging-tool.js");
  return {
    ...actual,
    resolveTools: async (spec: Parameters<typeof actual.resolveTools>[0]) => {
      const tools = await actual.resolveTools(spec);
      for (const [name, tool] of hangingTools({ key: KEY, hangMs: HANG_MS, risk: "high" })) tools.set(name, tool);
      return tools;
    },
  };
});

const { execute, one, repos } = await import("@forge/store");
const { executeRun } = await import("@forge/runtime");
const { sessionCookieValue } = await import("@forge/identity");
const { buildApp } = await import("../apps/api/src/app.js");
const { cleanupRealSessions, realSession, sessionHeaders } = await import("./helpers/real-session.js");
const { cleanupStubEffects, ensureStubEffectsTable, hangingToolNames } = await import("./helpers/hanging-tool.js");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const PROVIDER_KEY = `cdt-${suffix}`;
const EFFECT = hangingToolNames(KEY).effect;
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let providerId = "";

type Seeded = { runId: string; rowId: string; approvalId: string };
async function seedWaiting(): Promise<Seeded> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status: "waiting_approval", claimedBy: null, leaseSeconds: null });
  await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: EFFECT } });
  const rowId = await repos.addToolCall({ runId, toolKey: EFFECT, args: {}, risk: "high", status: "pending", idempotencyKey: `${runId}:s1:0`, readOnly: false, modelStep: 1, stepIndex: 0 });
  await repos.addMessage({ threadId, runId, seq: 2, role: "assistant", content: { text: "", tool_calls: [{ id: rowId, type: "function", function: { name: EFFECT, arguments: "{}" } }] } });
  const approval = await repos.addApproval({ runId, toolCallId: rowId, risk: "high", timeoutSeconds: 3600 });
  return { runId, rowId, approvalId: approval.id };
}
const runStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM runs WHERE id = ?", [id]))!.status;
const toolCallStatus = async (seeded: Seeded) => (await one<{ status: string }>("SELECT status FROM tool_calls WHERE id = ?", [seeded.rowId]))!.status;
/** Side effects of this seeded call (the tool gets idempotencyKey sha256(runId:toolCallId), tools.ts toolRequestKey). */
const effectsOf = async (seeded: Seeded) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM test_tool_stub_effects WHERE stub_key = ? AND idempotency_key = ?`, [KEY, createHash("sha256").update(`${seeded.runId}:${seeded.rowId}`).digest("hex")]))?.n ?? 0);
const cancel = (runId: string) => app.inject({ method: "POST", url: `/admin/api/runs/${runId}/cancel`, headers });
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

beforeAll(async () => {
  await ensureStubEffectsTable();
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: PROVIDER_KEY, name: "CDT stub", protocol: "openai-compatible", baseUrl: "https://llm.invalid/v1", createdBy: ADMIN_ID });
  await repos.createModel({ providerId, key: "stub-1", displayName: "stub", maxOutputTokens: 256 });
  agentId = await repos.createAgent({ key: `it-cdt-${suffix}`, name: "IT CDT", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: PROVIDER_KEY, model: "stub-1" }, toolsets: [] }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
});

afterAll(async () => {
  await cleanupStubEffects(KEY);
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN runs r ON r.id = a.resource_id WHERE r.agent_id = ?", [agentId]);
    for (const table of ["run_events", "run_steps", "messages", "approvals", "tool_calls"]) {
      await execute(`DELETE x FROM ${table} x JOIN runs r ON r.id = x.run_id WHERE r.agent_id = ?`, [agentId]);
    }
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  if (providerId) {
    await execute("DELETE FROM llm_models WHERE provider_id = ?", [providerId]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [providerId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("cancel while an approved tool call executes", () => {
  it("accepted (200), the tool call completes once, the Run ends cancelled (not succeeded)", { timeout: 30_000 }, async () => {
    const seeded = await seedWaiting();
    expect(await repos.decideApproval(seeded.approvalId, "approved", ADMIN_ID, "")).toBe(true);
    const execution = executeRun(seeded.runId, `w-cdt-${suffix}`);
    expect(await until(async () => (await effectsOf(seeded)) > 0), "the approved tool never started").toBe(true);
    expect(await toolCallStatus(seeded)).toBe("running");
    const cancelled = await cancel(seeded.runId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true });
    await execution;
    expect(await runStatus(seeded.runId)).toBe("cancelled");
    expect(await toolCallStatus(seeded)).toBe("succeeded");
    expect(await effectsOf(seeded)).toBe(1);
    // DCR-14 / I-RUN-06: once finished, cancel is still 409 RUN-7005.
    const again = await cancel(seeded.runId);
    expect(again.statusCode, again.body).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe("RUN-7005");
  });
});
