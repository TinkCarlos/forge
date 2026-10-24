import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Pure (no DB, no .env). runs.ts gets the REAL executeRun from packages/runtime/src/loop.ts; only its I/O edges are
// mocked: lease.claimRun (stage 1) and events.emit, the first await inside runClaimed (stage 2). A rejection at either
// stage must end in the route's .catch: one sanitized log line via describeTickError (like worker.ts), no unhandled
// rejection, and the decide request itself still answers 200.
class StubForgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
  }
}
vi.mock("@forge/core", () => ({
  ForgeError: StubForgeError,
  config: { LEASE_TTL_SECONDS: 30 },
  errors: {
    notFound: (m: string) => new StubForgeError("RUN-7001", m, 404),
    invalid: (m: string) => new StubForgeError("CFG-8501", m, 400),
    conflict: (m: string) => new StubForgeError("CFG-8503", m, 409),
  },
  OUTPUT_REPAIR_PREFIX: "",
}));
vi.mock("@forge/capabilities", () => ({ resolveTools: vi.fn() }));
vi.mock("@forge/models", () => ({ callModel: vi.fn() }));
vi.mock("@forge/governance", () => ({
  assertRunAccess: vi.fn(), buildArgsPreview: vi.fn(), canAccessRun: async () => true, maskArgsDeep: (v: unknown) => v, runFilterFor: vi.fn(),
}));
const RUN_ID = "run_EXEC_REJECT";
vi.mock("@forge/store", () => ({
  parseJsonValue: (v: unknown) => v,
  isRetryableWrite: () => false,
  repos: {
    getApproval: async (id: string) => ({ id, run_id: RUN_ID, status: "pending" }),
    getRun: async (id: string) => ({ id, status: "waiting_approval" }),
    decideApproval: async () => true,
    expirePendingApproval: vi.fn(),
    listOpenToolCalls: async () => [],
  },
}));
const claimRun = vi.fn();
vi.mock("../packages/runtime/src/lease", () => ({ claimRun, currentWorkerId: () => "worker-test", claimNext: vi.fn(), leaseEligible: vi.fn() }));
const emit = vi.fn();
vi.mock("../packages/runtime/src/events", () => ({ emit }));
vi.mock("@forge/runtime", async () => {
  const guard = await import("../packages/runtime/src/tick-guard");
  const loop = await import("../packages/runtime/src/loop");
  return { describeTickError: guard.describeTickError, executeRun: loop.executeRun, cancelRun: vi.fn(), isRunFinished: loop.isRunFinished, RUN_FINISHED_CODE: loop.RUN_FINISHED_CODE };
});
vi.mock("../apps/api/src/plugins/http-helpers.js", () => ({
  admin: async () => ({ principal: { id: "usr_admin" } }),
  bodyOf: (request: { body?: unknown }) => (request.body ?? {}) as Record<string, unknown>,
  param: (request: { params: Record<string, string> }, key: string) => request.params[key],
  stringBody: (body: Record<string, unknown>, key: string, fallback = "") => (typeof body[key] === "string" ? (body[key] as string) : fallback),
  writeAudit: vi.fn(async () => undefined),
  presentRun: vi.fn(),
  streamRun: vi.fn(),
}));

const { default: adminRunRoutes } = await import("../apps/api/src/routes/admin/runs");

let app: FastifyInstance;
const unhandled = vi.fn();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
// Shape of a mysql2 connection failure: message carries host:port, never a connection string; stack must not be logged.
const dbDown = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
const EXPECTED = `Run ${RUN_ID} execution failed: Error ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1`;

beforeAll(async () => {
  process.on("unhandledRejection", unhandled);
  app = Fastify({ logger: false });
  await app.register(adminRunRoutes);
  await app.ready();
});
afterEach(() => {
  vi.restoreAllMocks();
  claimRun.mockReset();
  emit.mockReset();
  unhandled.mockClear();
});
afterAll(async () => {
  process.off("unhandledRejection", unhandled);
  await app?.close();
});

async function decideAndCollect() {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const res = await app.inject({ method: "POST", url: "/admin/api/approvals/apr_1/decide", payload: { decision: "approved" } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  for (let i = 0; i < 10; i += 1) await flush();
  return errorLog;
}

function expectOneSanitizedLine(errorLog: ReturnType<typeof vi.spyOn>) {
  expect(unhandled).toHaveBeenCalledTimes(0);
  expect(errorLog).toHaveBeenCalledTimes(1);
  const args = errorLog.mock.calls[0] ?? [];
  expect(args).toHaveLength(1);
  expect(typeof args[0]).toBe("string"); // never the raw Error object
  const line = args[0] as string;
  expect(line).toBe(EXPECTED);
  expect(line).not.toMatch(/mysql:\/\/|\n\s+at /);
}

describe("POST /admin/api/approvals/:id/decide when executeRun rejects (fire-and-forget, K-20)", () => {
  it("stage 1: claimRun rejects -> 200, one sanitized error line, no unhandled rejection", async () => {
    claimRun.mockRejectedValueOnce(dbDown());
    const errorLog = await decideAndCollect();
    expect(claimRun).toHaveBeenCalledWith(RUN_ID, "worker-test", false);
    expect(emit).not.toHaveBeenCalled();
    expectOneSanitizedLine(errorLog);
  });

  it("stage 2: runClaimed rejects (first emit fails) -> 200, one sanitized error line, no unhandled rejection", async () => {
    claimRun.mockResolvedValueOnce({ run: { id: RUN_ID, agent_id: "agt_1", agent_version_id: "agv_1" }, previousStatus: "queued" });
    emit.mockRejectedValueOnce(dbDown());
    const errorLog = await decideAndCollect();
    expect(claimRun).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(RUN_ID, "run.started", { agentId: "agt_1", agentVersionId: "agv_1" });
    expectOneSanitizedLine(errorLog);
  });

  it("P2-05: an error whose message carries a connection string -> the logged line has no user, password or query value", async () => {
    // Fake credentials (test-only literals): the line must keep neither the user, the password, the host part nor the token.
    const leaky = Object.assign(new Error(`pool failed for ${["my", "sql"].join("")}://forge_user:pw-SEKRET@db.internal:3306/forge?ssl=1&password=q-SEKRET`), { code: "ECONNREFUSED" });
    claimRun.mockRejectedValueOnce(leaky);
    const errorLog = await decideAndCollect();
    expect(unhandled).toHaveBeenCalledTimes(0);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = String(errorLog.mock.calls[0]?.[0]);
    expect(line).toContain("[REDACTED]");
    for (const secret of ["forge_user", "pw-SEKRET", "q-SEKRET"]) expect(line).not.toContain(secret);
  });
});
