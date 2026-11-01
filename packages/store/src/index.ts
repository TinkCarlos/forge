import { rolesRepo } from "./repositories/roles.js";
import { secretsRepo } from "./repositories/secrets.js";
import { identityRepo } from "./repositories/identity.js";
import { openPlatformRepo } from "./repositories/openplatform.js";
import { agentsRepo } from "./repositories/agents.js";
import { capabilitiesRepo } from "./repositories/capabilities.js";
import { runsRepo } from "./repositories/runs.js";
import { schedulesRepo } from "./repositories/schedules.js";
import { auditRepo } from "./repositories/audit.js";
import { authSessionsRepo } from "./repositories/auth-sessions.js";
import { apiKeysRepo } from "./repositories/api-keys.js";
import { loginLimitsRepo } from "./repositories/login-limits.js";

export * from "./db.js";
export * from "./types.js";
export type { AccountWrite } from "./account-write.js";
export { migrateLegacyCredentials, migrateResourceCredentials, rewrapSecretVersions, rewrapSecretVersion, type SecretMaintenanceReport, type SecretMaintenanceFailure } from "./secret-maintenance.js";
export type { SecretFilter, CredentialResource } from "./repositories/secrets.js";
export { updateConfiguration, type ConfigurationAudit, type ConfigurationWrite } from "./configuration-revision.js";
export { CONFIGURATION_TABLES, type ConfigurationTable, type RevisionExpectation } from "./configuration-tables.js";
export type { AuthOidcStateRow, AuthSessionRow } from "./repositories/auth-sessions.js";
export { AUDIT_USER_AGENT_MAX, auditRequestContext, auditUserAgent, runWithAuditContext, type AuditRequestContext } from "./audit-context.js";
export { activeFence, fenceOwnerFor, LeaseLostError, leaseScope, withRunLease, type LeaseScope } from "./lease-fence.js";
export { AUDIT_ORG_SOURCES, AUDIT_PLATFORM_RESOURCES, DELETE_CLASS_AUDIT_ACTION, assertDeleteAuditOrgUnit, isDeleteClassAuditAction, buildAuditListQuery, userUpdateAuditEntries, type AuditListScope, type UserUpdateAuditEntry } from "./repositories/audit-scope-sql.js";

export const repos = {
  ...rolesRepo,
  ...loginLimitsRepo,
  ...secretsRepo,
  ...identityRepo,
  ...openPlatformRepo,
  ...apiKeysRepo,
  ...agentsRepo,
  ...capabilitiesRepo,
  ...runsRepo,
  ...schedulesRepo,
  ...auditRepo,
  ...authSessionsRepo,
};
export type { RoleWrite, RoleInput } from "./repositories/roles.js";
export type { ServiceAccountWrite } from "./repositories/identity.js";
export type { SsoRoleSnapshot } from "./sso-role-snapshot.js";

export { jobsRepo, type JobDefinitionRow, type JobExecutionRow, type JobVersionRow, type JobWrite } from "./repositories/jobs.js";

export { resourcePolicies, prospectiveConfigAllowed } from "./repositories/resource-access.js";
export { agentJobTargets } from "./repositories/resource-access.js";
export {messageConfigRepo,type MessageChannelRow,type ChannelVersionRow,type MessageWrite} from "./repositories/message-config.js";

export {messageDeliveryRepo,type MessageDeliveryRow,type MessageAttemptRow,type ClaimedMessage,type DeliveryWrite} from "./repositories/message-deliveries.js";

export {messageCatalogRepo,type MessageTemplateRow,type MessageTemplateVersionRow,type MessageRuleRow,type CatalogWrite,type MessageCatalogKind} from "./repositories/message-catalog.js";
export {messageRuleSourceOwner} from "./repositories/resource-access.js";

export {freezeMessageEvent,messageFanoutRepo,type MessageEvent,type FrozenMessageTarget} from "./repositories/message-fanout.js";
