import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// U-12 (pure, no DB, no .env): GET /admin/api/runs/:id must mask tool RESULTS like it masks tool arguments.
// The store is mocked to return a run whose tool call came back carrying credentials (an HTTP tool echoing an
// Authorization header and a token response). maskArgsDeep is the real implementation from packages/governance.
const SECRET = "s3cr3t-u12-result-value";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MTIifQ.c2lnbmF0dXJlLXUxMg";
const RESULT = {
  ok: true,
  content: JSON.stringify({ access_token: SECRET, expires_in: 3600 }),
  status: 200,
  headers: { authorization: `Bearer ${SECRET}`, "set-cookie": `sid=${SECRET}` },
  data: { url: `https://x.test/cb?token=${SECRET}&id=7`, password: SECRET, id_token: JWT, items: [{ api_key: SECRET, name: "kept" }] },
};
const RESULT_TEXT = JSON.stringify({ access_token: SECRET, expires_in: 3600 });

vi.mock("@forge/core", () => ({
  ForgeError: class extends Error {},
  errors: { notFound: (m: string) => new Error(m), invalid: (m: string) => new Error(m), conflict: (m: string) => new Error(m) },
}));
vi.mock("@forge/governance", async () => {
  const mask = await import("../packages/governance/src/mask-args");
  return { assertRunAccess: vi.fn(async () => undefined), buildArgsPreview: vi.fn(), canAccessRun: async () => true, maskArgsDeep: mask.maskArgsDeep, runFilterFor: vi.fn() };
});
vi.mock("@forge/runtime", () => ({ cancelRun: vi.fn(), describeTickError: vi.fn(), executeRun: vi.fn(), isRunFinished: vi.fn(), RUN_FINISHED_CODE: "RUN-7005" }));
vi.mock("@forge/store", () => ({
  repos: {
    getRun: async (id: string) => ({ id, status: "succeeded" }),
    listMessages: async () => [
      { id: "msg_1", seq: 1, role: "assistant", content_json: { text: "calling", tool_calls: [{ id: "tc_1", type: "function", function: { name: "http.call", arguments: JSON.stringify({ url: "https://x.test/login" }) } }] }, created_at: new Date(0) },
      { id: "msg_2", seq: 2, role: "tool", content_json: { text: RESULT_TEXT, tool_call_id: "tc_1", name: "http.call" }, created_at: new Date(0) },
    ],
    listToolCalls: async () => [
      { id: "tc_1", run_id: "run_U12", tool_key: "http.call", args_json: { url: "https://x.test/login" }, result_json: RESULT, result_text: RESULT_TEXT, status: "succeeded", risk_level: "low", approval_id: null, idempotency_key: null, attempt: 1, error_code: null },
    ],
    listApprovals: async () => [],
  },
}));
vi.mock("../apps/api/src/plugins/http-helpers.js", () => ({
  admin: async () => ({ principal: { id: "usr_admin" } }),
  bodyOf: (request: { body?: unknown }) => (request.body ?? {}) as Record<string, unknown>,
  param: (request: { params: Record<string, string> }, key: string) => request.params[key],
  stringBody: vi.fn(),
  writeAudit: vi.fn(async () => undefined),
  presentRun: (run: { id: string; status: string }) => ({ id: run.id, status: run.status }),
  streamRun: vi.fn(),
}));

const { default: adminRunRoutes } = await import("../apps/api/src/routes/admin/runs");
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(adminRunRoutes);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

describe("GET /admin/api/runs/:id masks tool results (U-12)", () => {
  it("result_json / result / result_text and the tool message carry no credential; structure and plain values kept", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/runs/run_U12" });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(JWT);
    expect(text.toLowerCase()).not.toContain("bearer s3cr3t");
    const body = res.json() as {
      toolCalls: Array<{ result_json: typeof RESULT; result: typeof RESULT; result_text: string; status: string; tool_key: string }>;
      messages: Array<{ role: string; content: { text: string; tool_call_id: string; name: string } }>;
    };
    const call = body.toolCalls[0]!;
    expect(call.tool_key).toBe("http.call");
    expect(call.status).toBe("succeeded");
    for (const result of [call.result_json, call.result]) {
      expect(result.status).toBe(200);
      expect(result.headers.authorization).toBe("***");
      expect(result.data.password).toBe("***");
      expect(result.data.id_token).toBe("***");
      expect(result.data.items[0]).toEqual({ api_key: "***", name: "kept" });
      expect(result.data.url).toContain("id=7");
      expect(JSON.parse(result.content)).toEqual({ access_token: "***", expires_in: 3600 });
    }
    expect(JSON.parse(call.result_text)).toEqual({ access_token: "***", expires_in: 3600 });
    const tool = body.messages.find((m) => m.role === "tool")!;
    expect(tool.content.tool_call_id).toBe("tc_1");
    expect(tool.content.name).toBe("http.call");
    expect(JSON.parse(tool.content.text)).toEqual({ access_token: "***", expires_in: 3600 });
  });
});
