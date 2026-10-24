import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { maskArgsDeep } from "../packages/governance/src/mask-args";
import { buildArgsPreview } from "../packages/governance/src/args-preview";

// P2 (architect 4:51, QA 714b3f3 §4 P2-2; pure, no DB, no .env): credentials written as prose inside a longer string
// ("use Bearer abc...", "password=x", "api_key: x", "密码：x") are masked by the shared rules, so run output, input,
// tool results and the approval args_preview agree. Assistant message text in GET /admin/api/runs/:id is masked too
// (before only its tool_calls were).
const PROSE: Array<[string, string]> = [
  ["call it with Bearer abcDEF123456 please", "abcDEF123456"],
  ["header was bearer zzTOKEN-998877.x", "zzTOKEN-998877"],
  ["login: admin password=hunter2x then retry", "hunter2x"],
  ["Password: Hunter-77 (temporary)", "Hunter-77"],
  ["set api_key=AKfake0099 in the env", "AKfake0099"],
  ["apiKey: fakeKEY4455, region us", "fakeKEY4455"],
  ["client_secret=cs-fake-8899;", "cs-fake-8899"],
  ["access_token=at.fake.7766 expires", "at.fake.7766"],
  ["token: tk_fake_5544", "tk_fake_5544"],
  ["auth Basic dXNlcjpwYXNzMTIz end", "dXNlcjpwYXNzMTIz"],
  ["数据库密码：Pw-fake-3322，请保管", "Pw-fake-3322"],
  ["secret = sh-fake-1100", "sh-fake-1100"],
];
const KEEP = [
  "the basic idea is simple",
  "we used 1200 tokens: fine",
  "password reset link sent",
  "token count is high",
  "明天开会?",
  "max_tokens=4096",
];

describe("prose credentials are masked by maskArgsDeep and args_preview", () => {
  it.each(PROSE)("%s", (text, secret) => {
    const masked = maskArgsDeep({ text, nested: [text] }) as { text: string; nested: string[] };
    expect(masked.text).not.toContain(secret);
    expect(masked.text).toContain("***");
    expect(masked.nested[0]).not.toContain(secret);
    expect(JSON.stringify(buildArgsPreview({ note: text }))).not.toContain(secret);
  });

  it.each(KEEP)("leaves ordinary prose alone: %s", (text) => {
    expect(maskArgsDeep({ text })).toEqual({ text });
  });

  it("only the secret is replaced, the sentence stays readable", () => {
    expect(maskArgsDeep("login: admin password=hunter2x then retry")).toBe("login: admin password=*** then retry");
    expect(maskArgsDeep("call it with Bearer abcDEF123456 please")).toBe("call it with Bearer *** please");
  });
});

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
      { id: "m1", seq: 1, role: "assistant", content_json: { text: "Done. Use Bearer abcDEF123456 and password=hunter2x" }, created_at: new Date(0) },
      { id: "m2", seq: 2, role: "assistant", content_json: { text: "calling", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{\"password\":\"pw-fake-1\"}" } }] }, created_at: new Date(0) },
    ],
    listToolCalls: async () => [],
    listApprovals: async () => [],
  },
}));
vi.mock("../apps/api/src/plugins/http-helpers.js", () => ({
  admin: async () => ({ principal: { id: "usr_admin" } }),
  bodyOf: (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>,
  param: (r: { params: Record<string, string> }, k: string) => r.params[k],
  stringBody: vi.fn(),
  writeAudit: vi.fn(async () => undefined),
  presentRun: (run: { id: string; status: string }) => ({ id: run.id, status: run.status }),
  streamRun: vi.fn(),
}));

let app: FastifyInstance;
beforeAll(async () => {
  const { default: routes } = await import("../apps/api/src/routes/admin/runs");
  app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe("GET /admin/api/runs/:id masks assistant message text", () => {
  it("assistant text and tool_calls carry no credential", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/runs/run_1" });
    expect(res.statusCode).toBe(200);
    for (const s of ["abcDEF123456", "hunter2x", "pw-fake-1"]) expect(res.body).not.toContain(s);
    const body = res.json() as { messages: Array<{ content: { text: string } }> };
    expect(body.messages[0]!.content.text).toBe("Done. Use Bearer *** and password=***");
    expect(body.messages[1]!.content.text).toBe("calling");
  });
});
