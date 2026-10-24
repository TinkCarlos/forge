import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// P2 (architect 4:51, QA 714b3f3 §4): POST /admin/api/plugins/:id/uninstall builds and validates its audit entry
// (delete-class guard: explicit orgUnitId, null for platform-level plugins) BEFORE uninstalling. If the guard throws,
// nothing is uninstalled; the audit row is written after the uninstall with the pre-validated parameters.
// Pure (no DB, no .env): store and helpers are mocked; the order of calls is recorded.
const calls: string[] = [];
const guardThrows = { on: false };

vi.mock("@forge/core", () => ({
  asRecord: (v: unknown) => v, assertNoEnvRefs: vi.fn(), assertOutboundUrlStatic: vi.fn(), config: {}, encryptSecret: vi.fn(),
  errors: { notFound: (m: string) => Object.assign(new Error(m), { statusCode: 404 }), invalid: (m: string) => Object.assign(new Error(m), { statusCode: 400 }) },
}));
vi.mock("@forge/capabilities", () => ({ discoverMcpTools: vi.fn() }));
vi.mock("@forge/governance", () => ({ assertOrgWritable: vi.fn(async () => undefined) }));
vi.mock("@forge/store", () => ({
  repos: {
    getPlugin: async (id: string) => (id === "plg_1" ? { id: "plg_1", key: "p" } : null),
    uninstallPlugin: vi.fn(async () => { calls.push("uninstall"); }),
  },
}));
vi.mock("../apps/api/src/plugins/http-helpers.js", () => {
  const guard = (action: string, opts: { orgUnitId?: string | null } = {}) => {
    calls.push(`guard:${action}:${JSON.stringify(opts)}`);
    if (guardThrows.on || opts.orgUnitId === undefined) throw new Error(`audit: delete-class action "${action}" requires an explicit orgUnitId`);
  };
  return {
    admin: async () => ({ principal: { id: "usr_admin", role: "platform_admin", dataScope: "all" } }),
    bodyOf: (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>,
    param: (r: { params: Record<string, string> }, k: string) => r.params[k],
    stringBody: vi.fn(), jsonBody: vi.fn(), requireBodyString: vi.fn(),
    // legacy path (write after the change): records, and applies the same guard as repos.audit
    writeAudit: vi.fn(async (_s: unknown, action: string, _t: string, _id: string | null, _d?: unknown, opts?: { orgUnitId?: string | null }) => {
      guard(action, opts);
      calls.push(`audit:${action}`);
    }),
    prepareAudit: vi.fn((_s: unknown, action: string, _t: string, _id: string | null, _d?: unknown, opts?: { orgUnitId?: string | null }) => {
      guard(action, opts);
      return async () => { calls.push(`audit:${action}`); };
    }),
  };
});

const { default: routes } = await import("../apps/api/src/routes/admin/plugins");
const { repos } = await import("@forge/store");
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { calls.length = 0; guardThrows.on = false; vi.mocked(repos.uninstallPlugin).mockClear(); });

describe("P2 plugin.uninstall validates its audit entry before uninstalling", () => {
  it("happy path: guard (orgUnitId null) -> uninstall -> audit, 200", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/plugins/plg_1/uninstall" });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls).toEqual(['guard:plugin.uninstall:{"orgUnitId":null}', "uninstall", "audit:plugin.uninstall"]);
  });

  it("guard throws -> 500 and nothing is uninstalled", async () => {
    guardThrows.on = true;
    const res = await app.inject({ method: "POST", url: "/admin/api/plugins/plg_1/uninstall" });
    expect(res.statusCode).toBe(500);
    expect(repos.uninstallPlugin).not.toHaveBeenCalled();
    expect(calls).not.toContain("uninstall");
  });

  it("unknown plugin -> 404, no guard, no uninstall", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/plugins/plg_x/uninstall" });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
