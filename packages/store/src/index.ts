import { identityRepo } from "./repositories/identity.js";
import { openPlatformRepo } from "./repositories/openplatform.js";
import { agentsRepo } from "./repositories/agents.js";
import { capabilitiesRepo } from "./repositories/capabilities.js";
import { runsRepo } from "./repositories/runs.js";
import { schedulesRepo } from "./repositories/schedules.js";
import { auditRepo } from "./repositories/audit.js";

export * from "./db.js";
export * from "./types.js";
export { activeFence, fenceOwnerFor, LeaseLostError, leaseScope, withRunLease, type LeaseScope } from "./lease-fence.js";
export { AUDIT_ORG_SOURCES, AUDIT_PLATFORM_RESOURCES, DELETE_CLASS_AUDIT_ACTION, assertDeleteAuditOrgUnit, isDeleteClassAuditAction, buildAuditListQuery, userUpdateAuditEntries, type AuditListScope, type UserUpdateAuditEntry } from "./repositories/audit-scope-sql.js";

export const repos = {
  ...identityRepo,
  ...openPlatformRepo,
  ...agentsRepo,
  ...capabilitiesRepo,
  ...runsRepo,
  ...schedulesRepo,
  ...auditRepo,
};
