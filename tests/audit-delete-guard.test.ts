import { beforeEach, describe, expect, it, vi } from "vitest";

// Delete-class audit actions must carry the resource department explicitly (architect ruling, 4:33):
// the caller passes orgUnitId (read before the delete) or an explicit null for platform-level resources; omitting it
// throws instead of silently resolving NULL from an already-deleted row. Pure: db and @forge/core are mocked.
const execute = vi.fn(async () => undefined);
const one = vi.fn(async () => null);
vi.mock("../packages/store/src/db.js", () => ({ execute, one, query: vi.fn(async () => []), json: (v: unknown) => JSON.stringify(v) }));
vi.mock("@forge/core", () => ({ ulidWithPrefix: (p: string) => `${p}_test` }));

const { auditRepo } = await import("../packages/store/src/repositories/audit.js");
const { isDeleteClassAuditAction } = await import("../packages/store/src/repositories/audit-scope-sql.js");

const base = { actorType: "user", actorId: "usr_1", resourceType: "plugin", resourceId: "plg_1" };
const orgArg = () => (execute.mock.calls.at(-1) as unknown as [string, unknown[]])[1][6];

describe("audit: delete-class actions need an explicit orgUnitId", () => {
  beforeEach(() => {
    execute.mockClear();
    one.mockClear();
  });

  it("classifies delete-class actions", () => {
    for (const a of ["plugin.uninstall", "agent.delete", "apikey.revoke", "skill.version.remove", "x.purge", "x.destroy", "x.archive"]) expect(isDeleteClassAuditAction(a), a).toBe(true);
    for (const a of ["plugin.install", "agent.update", "schedule.disable", "deleted.thing", "agent.delete_draft"]) expect(isDeleteClassAuditAction(a), a).toBe(false);
  });

  it("throws when orgUnitId is omitted (no row written, no lookup)", async () => {
    await expect(auditRepo.audit({ ...base, action: "plugin.uninstall" })).rejects.toThrow(/plugin\.uninstall.*orgUnitId/);
    await expect(auditRepo.audit({ ...base, action: "agent.delete", orgUnitId: undefined })).rejects.toThrow(/orgUnitId/);
    expect(execute).not.toHaveBeenCalled();
    expect(one).not.toHaveBeenCalled();
  });

  it("accepts an explicit null (platform-level) and an explicit department", async () => {
    await auditRepo.audit({ ...base, action: "plugin.uninstall", orgUnitId: null });
    expect(orgArg()).toBeNull();
    await auditRepo.audit({ ...base, action: "agent.delete", resourceType: "agent", orgUnitId: "org_a" });
    expect(orgArg()).toBe("org_a");
    expect(one).not.toHaveBeenCalled();
  });

  it("non-delete actions still resolve the department when omitted", async () => {
    await auditRepo.audit({ ...base, action: "plugin.install" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
