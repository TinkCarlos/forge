import { describe, expect, it } from "vitest";
import { buildScheduleIdentity } from "@forge/runtime";
import type { ServiceAccountRow } from "@forge/store";

// Pure unit tests (no DB): the identity a schedule runs as.
const CREATOR = "01J00000000000000000000001";
const SCHEDULE_ORG = "01J00000000000000000000000";
const ACCOUNT_ORG = "01J0000000000000000000SVC0";

const account: ServiceAccountRow = {
  id: "svc_01J0000000000000000000ABCD",
  key: "nightly-report",
  name: "Nightly Report Bot",
  description: "",
  org_unit_id: ACCOUNT_ORG,
  role: "operator",
  data_scope: "org",
  status: "active",
  created_by: CREATOR,
  created_at: new Date(),
  updated_at: new Date(),
};

const schedule = (extra: Record<string, unknown> = {}) => ({
  id: "sch_1",
  name: "Weekly summary",
  subject_type: "user",
  subject_id: CREATOR,
  org_unit_id: SCHEDULE_ORG,
  service_account_id: null,
  ...extra,
});

describe("buildScheduleIdentity", () => {
  it("bound operator/org account -> runs as the account (service subject, its role/org/data scope)", () => {
    const principal = buildScheduleIdentity(schedule({ service_account_id: account.id }), account);
    expect(principal).toEqual({
      type: "service",
      id: account.id,
      name: "Nightly Report Bot",
      role: "operator",
      orgUnitId: ACCOUNT_ORG,
      dataScope: "org",
    });
    expect(principal.role).not.toBe("platform_admin");
    expect(principal.id).not.toBe(CREATOR);
  });

  it("legacy schedule (service_account_id NULL) keeps the previous identity exactly", () => {
    const principal = buildScheduleIdentity(schedule(), null);
    expect(principal).toEqual({ type: "service", id: CREATOR, name: "Weekly summary", role: "user", orgUnitId: SCHEDULE_ORG, dataScope: "org" });
    expect(principal.role).not.toBe("platform_admin");
    expect(buildScheduleIdentity(schedule({ org_unit_id: null }), null).orgUnitId).toBeNull();
  });

  it("legacy schedule ignores a stray account argument", () => {
    expect(buildScheduleIdentity(schedule(), account).id).toBe(CREATOR);
  });

  it("bound schedule without its account row throws SCD-4801 instead of falling back to the legacy identity", () => {
    expect(() => buildScheduleIdentity(schedule({ service_account_id: account.id }), null)).toThrow(expect.objectContaining({ code: "SCD-4801" }));
    expect(() => buildScheduleIdentity(schedule({ service_account_id: "svc_other" }), account)).toThrow(expect.objectContaining({ code: "SCD-4801" }));
  });

  it("bound platform_admin account is refused with SCD-4804 (service accounts may never run as platform_admin)", () => {
    const admin = { ...account, role: "platform_admin", data_scope: "all" };
    expect(() => buildScheduleIdentity(schedule({ service_account_id: admin.id }), admin)).toThrow(expect.objectContaining({ code: "SCD-4804", httpStatus: 409 }));
  });
});
