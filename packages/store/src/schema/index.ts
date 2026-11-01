// Baseline imported from a fresh 001–008 MySQL test database; maintain future changes here.
import { mysqlTable, customType, type MySqlTableExtraConfigValue, check, index, foreignKey, primaryKey, unique, char, varchar, mediumtext, tinyint, json, datetime, text, int, bigint, decimal } from "drizzle-orm/mysql-core"
import { sql } from "drizzle-orm"

const asciiChar = customType<{ data: string; config: { length: number } }>({ dataType: (config) => `char(${config!.length}) CHARACTER SET ascii COLLATE ascii_bin` });
const asciiVarchar = customType<{ data: string; config: { length: number } }>({ dataType: (config) => `varchar(${config!.length}) CHARACTER SET ascii COLLATE ascii_bin` });
const bufferColumn = customType<{ data: Buffer; config: { sqlType: string } }>({ dataType: (config) => config!.sqlType });
const asciiId = customType<{ data: string }>({ dataType: () => "char(26) CHARACTER SET ascii COLLATE ascii_bin" });
const identityVarchar = customType<{ data: string; config: { length: number } }>({ dataType: config => `varchar(${config!.length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` });

export const agentVersions = mysqlTable("agent_versions", {
	id: asciiId().notNull(),
	agentId: asciiId("agent_id").notNull(),
	version: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('draft').notNull(),
	instructions: mediumtext().notNull(),
	specJson: json("spec_json").notNull(),
	changelog: varchar({ length: 2048 }).default('').notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	publishedAt: datetime("published_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_agent_versions_status").on(table.agentId, table.status),
  primaryKey({ columns: [table.id], name: "agent_versions_id"}),
  unique("uk_agent_versions").on(table.agentId, table.version),
  foreignKey({ name: "fk_agent_versions_agent", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("restrict").onUpdate("no action"),
]);

export const agents = mysqlTable("agents", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	ownerOrgUnitId: asciiId("owner_org_unit_id"),
	latestVersionId: asciiId("latest_version_id"),
	publishedVersionId: asciiId("published_version_id"),
	apiEnabled: tinyint("api_enabled").default(0).notNull(),
	apiScopesJson: json("api_scopes_json"),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
	deletedAt: datetime("deleted_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_agents_api").on(table.apiEnabled, table.status),
  index("idx_agents_org").on(table.ownerOrgUnitId, table.status),
  primaryKey({ columns: [table.id], name: "agents_id"}),
  unique("uk_agents_key").on(table.key),
]);

export const apiApps = mysqlTable("api_apps", {
  webhookSecretId: asciiId("webhook_secret_id"),
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	ownerOrgUnitId: asciiId("owner_org_unit_id"),
	status: varchar({ length: 16 }).default('active').notNull(),
	scopesJson: json("scopes_json").notNull(),
	webhookUrl: varchar("webhook_url", { length: 2048 }),
	webhookSecretEncrypted: text("webhook_secret_encrypted"),
	rateLimitPerMinute: int("rate_limit_per_minute").default(60).notNull(),
	dailyQuota: int("daily_quota").default(1000).notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "api_apps_id"}),
  unique("uk_api_apps_key").on(table.key),
]);

export const apiKeys = mysqlTable("api_keys", {
	id: asciiId().notNull(),
	appId: asciiId("app_id").notNull(),
	name: varchar({ length: 128 }).notNull(),
	prefix: varchar({ length: 24 }).notNull(),
	keyHash: char("key_hash", { length: 64 }).notNull(),
	scopesJson: json("scopes_json").notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }),
	lastUsedAt: datetime("last_used_at", { mode: 'string', fsp: 3 }),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_api_keys_app").on(table.appId, table.status),
  primaryKey({ columns: [table.id], name: "api_keys_id"}),
  unique("uk_api_keys_prefix").on(table.prefix),
  foreignKey({ name: "fk_api_keys_app", columns: [table.appId], foreignColumns: [apiApps.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const approvals = mysqlTable("approvals", {
	id: asciiId().notNull(),
	runId: asciiId("run_id").notNull(),
	toolCallId: asciiId("tool_call_id").notNull(),
	status: varchar({ length: 16 }).default('pending').notNull(),
	riskLevel: varchar("risk_level", { length: 16 }).notNull(),
	expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }).notNull(),
	decidedBy: asciiId("decided_by"),
	decidedAt: datetime("decided_at", { mode: 'string', fsp: 3 }),
	comment: varchar({ length: 1024 }),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	reason: varchar({ length: 16 }).default('policy').notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_approvals_run").on(table.runId),
  index("idx_approvals_status").on(table.status, table.expiresAt),
  primaryKey({ columns: [table.id], name: "approvals_id"}),
  foreignKey({ name: "fk_approvals_run", columns: [table.runId], foreignColumns: [runs.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const auditLogs = mysqlTable("audit_logs", {
	id: asciiId().notNull(),
	actorName: varchar("actor_name", { length: 128 }),
	outcome: varchar({ length: 16 }).default('success').notNull(),
	actorType: varchar("actor_type", { length: 16 }).notNull(),
	actorId: asciiId("actor_id"),
	action: varchar({ length: 64 }).notNull(),
	resourceType: varchar("resource_type", { length: 32 }).notNull(),
	resourceId: asciiId("resource_id"),
	detailsJson: json("details_json"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	orgUnitId: asciiId("org_unit_id"),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_audit_actor").on(table.actorType, table.actorId, table.createdAt),
  index("idx_audit_action_page").on(table.action, table.createdAt, table.id),
  index("idx_audit_outcome_page").on(table.outcome, table.createdAt, table.id),
  index("idx_audit_org").on(table.orgUnitId, table.createdAt),
  index("idx_audit_resource").on(table.resourceType, table.resourceId, table.createdAt),
  primaryKey({ columns: [table.id], name: "audit_logs_id"}),
]);

export const authLoginLimits = mysqlTable("auth_login_limits", {
  keyHash: asciiChar("key_hash", { length: 64 }).notNull(),
  attempts: int({ unsigned: true }).default(0).notNull(),
  windowStartedAt: datetime("window_started_at", { mode: 'string', fsp: 3 }).notNull(),
  expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }).notNull(),
}, (table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.keyHash], name: "auth_login_limits_key_hash" }),
  index("idx_auth_login_limits_expires").on(table.expiresAt),
]);

export const authOidcStates = mysqlTable("auth_oidc_states", {
	stateHash: asciiChar("state_hash", { length: 64 }).notNull(),
	verifier: asciiVarchar({ length: 128 }).notNull(),
	nonce: asciiVarchar({ length: 64 }).notNull(),
	returnTo: varchar("return_to", { length: 2048 }).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_auth_oidc_states_expires").on(table.expiresAt),
  primaryKey({ columns: [table.stateHash], name: "auth_oidc_states_state_hash"}),
]);

export const authSessions = mysqlTable("auth_sessions", {
	tokenHash: asciiChar("token_hash", { length: 64 }).notNull(),
	userId: asciiId("user_id").notNull(),
	csrfToken: asciiVarchar("csrf_token", { length: 64 }).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	lastSeenAt: datetime("last_seen_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_auth_sessions_expires").on(table.expiresAt),
  index("idx_auth_sessions_user").on(table.userId),
  primaryKey({ columns: [table.tokenHash], name: "auth_sessions_token_hash"}),
  foreignKey({ name: "fk_auth_sessions_user", columns: [table.userId], foreignColumns: [users.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const dataPolicies = mysqlTable("data_policies", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	role: varchar({ length: 32 }).notNull(),
	resourceType: varchar("resource_type", { length: 32 }).notNull(),
	actionsJson: json("actions_json").notNull(),
	scopeType: varchar("scope_type", { length: 24 }).notNull(),
	effect: varchar({ length: 8 }).default('allow').notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "data_policies_id"}),
  unique("uk_data_policies").on(table.role, table.resourceType, table.scopeType, table.effect),
]);

export const files = mysqlTable("files", {
	id: asciiId().notNull(),
	ownerType: varchar("owner_type", { length: 16 }).notNull(),
	ownerId: asciiId("owner_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	mimeType: varchar("mime_type", { length: 128 }).notNull(),
	size: bigint({ mode: "number", unsigned: true }).notNull(),
	storagePath: varchar("storage_path", { length: 1024 }).notNull(),
	checksum: char({ length: 64 }).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_files_owner").on(table.ownerType, table.ownerId),
  primaryKey({ columns: [table.id], name: "files_id"}),
]);

export const idempotencyKeys = mysqlTable("idempotency_keys", {
	id: asciiId().notNull(),
	scope: varchar({ length: 64 }).notNull(),
	idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
	requestHash: char("request_hash", { length: 64 }).notNull(),
	statusCode: int("status_code").default(0).notNull(),
	responseJson: json("response_json"),
	runId: asciiId("run_id"),
	expiresAt: datetime("expires_at", { mode: 'string', fsp: 3 }).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_idempotency_expires").on(table.expiresAt),
  primaryKey({ columns: [table.id], name: "idempotency_keys_id"}),
  unique("uk_idempotency_scope_key").on(table.scope, table.idempotencyKey),
]);

export const llmModels = mysqlTable("llm_models", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	providerId: asciiId("provider_id").notNull(),
	key: varchar({ length: 128 }).notNull(),
	displayName: varchar("display_name", { length: 128 }).notNull(),
	capabilitiesJson: json("capabilities_json"),
	contextWindow: int("context_window").default(32768).notNull(),
	maxOutputTokens: int("max_output_tokens").default(4096).notNull(),
	inputPricePerMtok: decimal("input_price_per_mtok", { precision: 12, scale: 6 }).default('0.000000').notNull(),
	outputPricePerMtok: decimal("output_price_per_mtok", { precision: 12, scale: 6 }).default('0.000000').notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "llm_models_id"}),
  unique("uk_llm_models").on(table.providerId, table.key),
  foreignKey({ name: "fk_llm_models_provider", columns: [table.providerId], foreignColumns: [llmProviders.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const llmProviders = mysqlTable("llm_providers", {
  secretId: asciiId("secret_id"),
  headerSecretRefsJson: json("header_secret_refs_json"),
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	protocol: varchar({ length: 32 }).default('openai-compatible').notNull(),
	baseUrl: varchar("base_url", { length: 2048 }).notNull(),
	apiKeyEncrypted: text("api_key_encrypted"),
	headersJson: json("headers_json"),
	timeoutMs: int("timeout_ms").default(120000).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "llm_providers_id"}),
  unique("uk_llm_providers_key").on(table.key),
]);

export const llmRoutes = mysqlTable("llm_routes", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	candidatesJson: json("candidates_json").notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "llm_routes_id"}),
  unique("uk_llm_routes_key").on(table.key),
]);

export const mcpServers = mysqlTable("mcp_servers", {
  headerSecretRefsJson: json("header_secret_refs_json"),
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	transport: varchar({ length: 16 }).default('http').notNull(),
	url: varchar({ length: 2048 }).notNull(),
	headersJson: json("headers_json"),
	status: varchar({ length: 16 }).default('active').notNull(),
	lastError: varchar("last_error", { length: 1024 }),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
	deletedAt: datetime("deleted_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "mcp_servers_id"}),
  unique("uk_mcp_servers_key").on(table.key),
]);

export const mcpTools = mysqlTable("mcp_tools", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	serverId: asciiId("server_id").notNull(),
	name: varchar({ length: 128 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	inputSchemaJson: json("input_schema_json"),
	riskLevel: varchar("risk_level", { length: 16 }).default('medium').notNull(),
	enabled: tinyint().default(1).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
	readOnly: tinyint("read_only").default(0).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "mcp_tools_id"}),
  unique("uk_mcp_tools").on(table.serverId, table.name),
  foreignKey({ name: "fk_mcp_tools_server", columns: [table.serverId], foreignColumns: [mcpServers.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const messages = mysqlTable("messages", {
  threadSeq: bigint("thread_seq", {mode: "bigint", unsigned: true}),
  protocolVersion: varchar("protocol_version", {length:32}),
	id: asciiId().notNull(),
	threadId: asciiId("thread_id").notNull(),
	runId: asciiId("run_id").notNull(),
	seq: int({ unsigned: true }).notNull(),
	role: varchar({ length: 16 }).notNull(),
	contentJson: json("content_json").notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_messages_thread").on(table.threadId, table.seq),
  primaryKey({ columns: [table.id], name: "messages_id"}),
  unique("uk_messages_run_seq").on(table.runId, table.seq),
  unique("uk_messages_thread_seq").on(table.threadId,table.threadSeq),
  foreignKey({ name: "fk_messages_run", columns: [table.runId], foreignColumns: [runs.id] }).onDelete("cascade").onUpdate("no action"),
  foreignKey({ name: "fk_messages_thread", columns: [table.threadId], foreignColumns: [threads.id] }).onDelete("restrict").onUpdate("no action"),
]);

export const oidcRoleMappings = mysqlTable("oidc_role_mappings", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	agentRoleCode: varchar("agent_role_code", { length: 100 }).notNull(),
	agentRoleName: varchar("agent_role_name", { length: 100 }).default('').notNull(),
	localRole: varchar("local_role", { length: 32 }).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "oidc_role_mappings_id"}),
  unique("uk_oidc_role_mappings").on(table.agentRoleCode, table.agentRoleName),
]);

export const orgUnits = mysqlTable("org_units", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	parentId: asciiId("parent_id"),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	path: varchar({ length: 512 }).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_org_units_path").on(table.path),
  primaryKey({ columns: [table.id], name: "org_units_id"}),
  unique("uk_org_units_key").on(table.key),
]);

export const plugins = mysqlTable("plugins", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 128 }).notNull(),
	version: varchar({ length: 32 }).notNull(),
	type: varchar({ length: 32 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	manifestJson: json("manifest_json").notNull(),
	resourcesJson: json("resources_json").notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "plugins_id"}),
  unique("uk_plugins").on(table.key, table.version),
]);

export const runEvents = mysqlTable("run_events", {
	runId: asciiId("run_id").notNull(),
	seq: int({ unsigned: true }).notNull(),
	type: varchar({ length: 64 }).notNull(),
	dataJson: json("data_json").notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_run_events_created").on(table.createdAt),
  primaryKey({ columns: [table.runId, table.seq], name: "run_events_run_id_seq"}),
  foreignKey({ name: "fk_run_events_run", columns: [table.runId], foreignColumns: [runs.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const runSteps = mysqlTable("run_steps", {
	id: asciiId().notNull(),
	runId: asciiId("run_id").notNull(),
	seq: int({ unsigned: true }).notNull(),
	type: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('running').notNull(),
	toolCallId: asciiId("tool_call_id"),
	summaryJson: json("summary_json"),
	errorCode: varchar("error_code", { length: 16 }),
	inputTokens: int("input_tokens", { unsigned: true }).default(0).notNull(),
	outputTokens: int("output_tokens", { unsigned: true }).default(0).notNull(),
	costUsd: decimal("cost_usd", { precision: 12, scale: 6 }).default('0.000000').notNull(),
	startedAt: datetime("started_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	endedAt: datetime("ended_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_run_steps_type").on(table.runId, table.type),
  primaryKey({ columns: [table.id], name: "run_steps_id"}),
  unique("uk_run_steps").on(table.runId, table.seq),
  foreignKey({ name: "fk_run_steps_run", columns: [table.runId], foreignColumns: [runs.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const runs = mysqlTable("runs", {
  runtimeEngine: varchar("runtime_engine", {length:24}).default("mysql-legacy").notNull(),
  snapshotQuality: varchar("snapshot_quality", {length:16}).default("legacy").notNull(),
  retryOfRunId: asciiId("retry_of_run_id"),
  workspaceId: asciiId("workspace_id"),
  workflowId: varchar("workflow_id", {length:128}),
	id: asciiId().notNull(),
	threadId: asciiId("thread_id").notNull(),
	agentId: asciiId("agent_id").notNull(),
	agentVersionId: asciiId("agent_version_id").notNull(),
	appId: asciiId("app_id"),
	orgUnitId: asciiId("org_unit_id"),
	subjectType: varchar("subject_type", { length: 16 }).notNull(),
	subjectId: asciiId("subject_id").notNull(),
	status: varchar({ length: 24 }).default('queued').notNull(),
	triggerType: varchar("trigger_type", { length: 16 }).default('manual').notNull(),
	triggerRef: varchar("trigger_ref", { length: 128 }),
	inputJson: json("input_json").notNull(),
	outputJson: json("output_json"),
	usageJson: json("usage_json"),
	costUsd: decimal("cost_usd", { precision: 12, scale: 6 }).default('0.000000').notNull(),
	errorCode: varchar("error_code", { length: 16 }),
	errorMessage: varchar("error_message", { length: 1024 }),
	cancelRequested: tinyint("cancel_requested").default(0).notNull(),
	claimedBy: varchar("claimed_by", { length: 128 }),
	leaseExpiresAt: datetime("lease_expires_at", { mode: 'string', fsp: 3 }),
	heartbeatAt: datetime("heartbeat_at", { mode: 'string', fsp: 3 }),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	startedAt: datetime("started_at", { mode: 'string', fsp: 3 }),
	completedAt: datetime("completed_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_runs_agent_created").on(table.agentId, table.createdAt),
  index("idx_runs_engine_status").on(table.runtimeEngine,table.status,table.createdAt,table.id),
  index("idx_runs_thread_status").on(table.threadId,table.status,table.createdAt,table.id),
  unique("uk_runs_workflow").on(table.workflowId),
  index("idx_runs_app_created").on(table.appId, table.createdAt),
  index("idx_runs_lease").on(table.status, table.leaseExpiresAt),
  index("idx_runs_org").on(table.orgUnitId, table.createdAt),
  index("idx_runs_status_created").on(table.status, table.createdAt),
  index("idx_runs_subject").on(table.subjectType, table.subjectId, table.createdAt),
  primaryKey({ columns: [table.id], name: "runs_id"}),
  foreignKey({ name: "fk_runs_agent", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("restrict").onUpdate("no action"),
  foreignKey({ name: "fk_runs_agent_version", columns: [table.agentVersionId], foreignColumns: [agentVersions.id] }).onDelete("restrict").onUpdate("no action"),
  foreignKey({ name: "fk_runs_thread", columns: [table.threadId], foreignColumns: [threads.id] }).onDelete("restrict").onUpdate("no action"),
]);

export const schedules = mysqlTable("schedules", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	agentId: asciiId("agent_id").notNull(),
	orgUnitId: asciiId("org_unit_id"),
	subjectType: varchar("subject_type", { length: 16 }).default('service').notNull(),
	subjectId: asciiId("subject_id").notNull(),
	serviceAccountId: asciiId("service_account_id"),
	cron: varchar({ length: 128 }).notNull(),
	timezone: varchar({ length: 64 }).default('Asia/Shanghai').notNull(),
	inputJson: json("input_json"),
	versionPolicy: varchar("version_policy", { length: 24 }).default('published').notNull(),
	pinnedVersionId: asciiId("pinned_version_id"),
	concurrencyPolicy: varchar("concurrency_policy", { length: 24 }).default('skip').notNull(),
	failureCount: int("failure_count", { unsigned: true }).default(0).notNull(),
	lastErrorCode: varchar("last_error_code", { length: 16 }),
	status: varchar({ length: 16 }).default('disabled').notNull(),
	nextRunAt: datetime("next_run_at", { mode: 'string', fsp: 3 }),
	lastRunId: asciiId("last_run_id"),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_schedules_due").on(table.status, table.nextRunAt),
  primaryKey({ columns: [table.id], name: "schedules_id"}),
  unique("uk_schedules_key").on(table.key),
  foreignKey({ name: "fk_schedules_agent", columns: [table.agentId], foreignColumns: [agents.id] }).onDelete("restrict").onUpdate("no action"),
]);

export const serviceAccounts = mysqlTable("service_accounts", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	orgUnitId: asciiId("org_unit_id"),
	role: varchar({ length: 32 }).default('user').notNull(),
	dataScope: varchar("data_scope", { length: 32 }).default('org').notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_service_accounts_status").on(table.status),
  primaryKey({ columns: [table.id], name: "service_accounts_id"}),
  unique("uk_service_accounts_key").on(table.key),
]);

export const settings = mysqlTable("settings", {
  revision: int({ unsigned: true }).default(1).notNull(),
	key: varchar({ length: 128 }).notNull(),
	valueJson: json("value_json").notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.key], name: "settings_key"}),
]);

export const skillVersions = mysqlTable("skill_versions", {
	id: asciiId().notNull(),
	skillId: asciiId("skill_id").notNull(),
	version: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 16 }).default('draft').notNull(),
	contentMd: mediumtext("content_md").notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	publishedAt: datetime("published_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "skill_versions_id"}),
  unique("uk_skill_versions").on(table.skillId, table.version),
  foreignKey({ name: "fk_skill_versions_skill", columns: [table.skillId], foreignColumns: [skills.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const skills = mysqlTable("skills", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	latestVersionId: asciiId("latest_version_id"),
	publishedVersionId: asciiId("published_version_id"),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
	deletedAt: datetime("deleted_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "skills_id"}),
  unique("uk_skills_key").on(table.key),
]);

export const threads = mysqlTable("threads", {
  appId: asciiId("app_id"),
  activeRunId: asciiId("active_run_id"),
  nextMessageSeq: bigint("next_message_seq", {mode:"bigint",unsigned:true}).default(sql`1`).notNull(),
  revision: int({unsigned:true}).default(1).notNull(),
  deletedAt: datetime("deleted_at",{mode:"string",fsp:3}),
	id: asciiId().notNull(),
	agentId: asciiId("agent_id"),
	orgUnitId: asciiId("org_unit_id"),
	subjectType: varchar("subject_type", { length: 16 }).notNull(),
	subjectId: asciiId("subject_id").notNull(),
	title: varchar({ length: 255 }).default('').notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_threads_subject").on(table.subjectType, table.subjectId),
  index("idx_threads_app_created").on(table.appId,table.createdAt,table.id),
  primaryKey({ columns: [table.id], name: "threads_id"}),
]);

export const toolCalls = mysqlTable("tool_calls", {
	id: asciiId().notNull(),
	runId: asciiId("run_id").notNull(),
	toolKey: varchar("tool_key", { length: 160 }).notNull(),
	argsJson: json("args_json").notNull(),
	resultJson: json("result_json"),
	resultText: mediumtext("result_text"),
	status: varchar({ length: 24 }).default('running').notNull(),
	riskLevel: varchar("risk_level", { length: 16 }).default('low').notNull(),
	approvalId: asciiId("approval_id"),
	idempotencyKey: varchar("idempotency_key", { length: 191 }),
	attempt: int({ unsigned: true }).default(1).notNull(),
	errorCode: varchar("error_code", { length: 16 }),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
	readOnly: tinyint("read_only").default(0).notNull(),
	callId: varchar("call_id", { length: 191 }),
	modelStep: int("model_step", { unsigned: true }),
	stepIndex: int("step_index", { unsigned: true }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_tool_calls_run").on(table.runId, table.createdAt),
  primaryKey({ columns: [table.id], name: "tool_calls_id"}),
  unique("uk_tool_calls_run_idem").on(table.runId, table.idempotencyKey),
  foreignKey({ name: "fk_tool_calls_run", columns: [table.runId], foreignColumns: [runs.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const toolSources = mysqlTable("tool_sources", {
  headerSecretRefsJson: json("header_secret_refs_json"),
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	key: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	baseUrl: varchar("base_url", { length: 2048 }).notNull(),
	headersJson: json("headers_json"),
	specJson: json("spec_json").notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdBy: asciiId("created_by"),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "tool_sources_id"}),
  unique("uk_tool_sources_key").on(table.key),
]);

export const tools = mysqlTable("tools", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	sourceId: asciiId("source_id").notNull(),
	name: varchar({ length: 128 }).notNull(),
	operationId: varchar("operation_id", { length: 128 }).notNull(),
	method: varchar({ length: 8 }).notNull(),
	path: varchar({ length: 1024 }).notNull(),
	description: varchar({ length: 1024 }).default('').notNull(),
	inputSchemaJson: json("input_schema_json"),
	riskLevel: varchar("risk_level", { length: 16 }).default('low').notNull(),
	enabled: tinyint().default(1).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	readOnly: tinyint("read_only").default(0).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  primaryKey({ columns: [table.id], name: "tools_id"}),
  unique("uk_tools").on(table.sourceId, table.name),
  foreignKey({ name: "fk_tools_source", columns: [table.sourceId], foreignColumns: [toolSources.id] }).onDelete("cascade").onUpdate("no action"),
]);

export const users = mysqlTable("users", {
  revision: int({ unsigned: true }).default(1).notNull(),
	id: asciiId().notNull(),
	username: varchar({ length: 64 }).notNull(),
	email: varchar({ length: 255 }).notNull(),
	displayName: varchar("display_name", { length: 128 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }),
	role: varchar({ length: 32 }).default('user').notNull(),
	dataScope: varchar("data_scope", { length: 16 }).default('self').notNull(),
	orgUnitId: asciiId("org_unit_id"),
	idpSubject: identityVarchar("idp_subject", { length: 255 }),
	idpIssuer: identityVarchar("idp_issuer", { length: 2048 }),
	status: varchar({ length: 16 }).default('active').notNull(),
	isEmergencyAdmin: tinyint("is_emergency_admin").default(0).notNull(),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_users_org").on(table.orgUnitId),
  primaryKey({ columns: [table.id], name: "users_id"}),
  unique("uk_users_email").on(table.email),
  unique("uk_users_idp_subject").on(table.idpSubject),
  unique("uk_users_username").on(table.username),
]);

export const webhookDeliveries = mysqlTable("webhook_deliveries", {
	id: asciiId().notNull(),
	appId: asciiId("app_id").notNull(),
	eventId: varchar("event_id", { length: 64 }).notNull(),
	eventType: varchar("event_type", { length: 64 }).notNull(),
	payloadJson: json("payload_json").notNull(),
	status: varchar({ length: 16 }).default('pending').notNull(),
	attempts: int({ unsigned: true }).default(0).notNull(),
	nextAttemptAt: datetime("next_attempt_at", { mode: 'string', fsp: 3 }).notNull(),
	responseStatus: int("response_status"),
	errorMessage: varchar("error_message", { length: 512 }),
	errorCode: varchar("error_code", { length: 16 }),
	createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
	deliveredAt: datetime("delivered_at", { mode: 'string', fsp: 3 }),
},
(table): MySqlTableExtraConfigValue[] => [
  index("idx_webhook_delivery_due").on(table.status, table.nextAttemptAt),
  primaryKey({ columns: [table.id], name: "webhook_deliveries_id"}),
  unique("uk_webhook_delivery_event").on(table.appId, table.eventId),
  foreignKey({ name: "fk_webhook_deliveries_app", columns: [table.appId], foreignColumns: [apiApps.id] }).onDelete("cascade").onUpdate("no action"),
]);


export const secrets = mysqlTable("secrets", {
  id: asciiId().notNull(),
  key: varchar({ length: 64 }).notNull(),
  name: varchar({ length: 128 }).notNull(),
  description: varchar({ length: 1024 }).default("").notNull(),
  scopeType: varchar("scope_type", { length: 16 }).notNull(),
  scopeId: asciiId("scope_id").default("").notNull(),
  scopeResourceType: varchar("scope_resource_type", { length: 32 }).default("").notNull(),
  ownerOrgUnitId: asciiId("owner_org_unit_id"),
  activeVersionId: asciiId("active_version_id"),
  status: varchar({ length: 16 }).default("active").notNull(),
  revision: int({ unsigned: true }).default(1).notNull(),
  createdBy: asciiId("created_by"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
  deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
}, table => [
  primaryKey({ columns: [table.id], name: "secrets_id" }),
  unique("uk_secrets_scope").on(table.scopeType, table.scopeResourceType, table.scopeId, table.key),
  index("idx_secrets_org").on(table.ownerOrgUnitId, table.status, table.id),
  index("idx_secrets_creator").on(table.createdBy, table.status, table.id),
]);

export const secretVersions = mysqlTable("secret_versions", {
  id: asciiId().notNull(),
  secretId: asciiId("secret_id").notNull(),
  version: int({ unsigned: true }).notNull(),
  ciphertext: bufferColumn({ sqlType: "mediumblob" }).notNull(),
  nonce: bufferColumn({ sqlType: "varbinary(12)" }).notNull(),
  tag: bufferColumn({ sqlType: "varbinary(16)" }).notNull(),
  encryptedDek: bufferColumn("encrypted_dek", { sqlType: "varbinary(32)" }).notNull(),
  dekNonce: bufferColumn("dek_nonce", { sqlType: "varbinary(12)" }).notNull(),
  dekTag: bufferColumn("dek_tag", { sqlType: "varbinary(16)" }).notNull(),
  keyVersion: varchar("key_version", { length: 64 }).notNull(),
  createdBy: asciiId("created_by"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [
  primaryKey({ columns: [table.id], name: "secret_versions_id" }),
  unique("uk_secret_versions").on(table.secretId, table.version),
  index("idx_secret_versions_key").on(table.keyVersion, table.id),
  foreignKey({ name: "fk_secret_versions_secret", columns: [table.secretId], foreignColumns: [secrets.id] }).onDelete("restrict"),
]);

export const resourceReferences = mysqlTable("resource_references", {
  id: asciiId().notNull(),
  fromType: varchar("from_type", { length: 32 }).notNull(),
  fromId: asciiId("from_id").notNull(),
  fromVersionId: asciiId("from_version_id"),
  toType: varchar("to_type", { length: 32 }).notNull(),
  toId: asciiId("to_id").notNull(),
  toKey: varchar("to_key", { length: 64 }).notNull(),
  toVersion: varchar("to_version", { length: 64 }),
  bindingKey: varchar("binding_key", { length: 255 }).notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [
  primaryKey({ columns: [table.id], name: "resource_references_id" }),
  unique("uk_resource_reference_binding").on(table.fromType, table.fromId, table.bindingKey),
  index("idx_resource_refs_to").on(table.toType, table.toId),
  index("idx_resource_refs_from").on(table.fromType, table.fromId),
]);

export const roles = mysqlTable("roles", {
  id: asciiId().notNull(), key: varchar({ length: 32 }).notNull(), name: varchar({ length: 128 }).notNull(),
  description: varchar({ length: 1024 }).default('').notNull(), builtin: tinyint().default(0).notNull(),
  status: varchar({ length: 16 }).default('active').notNull(), revision: int({ unsigned: true }).default(1).notNull(),
  createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  updatedAt: datetime("updated_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
}, table => [primaryKey({ columns: [table.id], name: "roles_id" }), unique("uk_roles_key").on(table.key)]);

export const permissions = mysqlTable("permissions", {
  key: varchar({ length: 64 }).notNull(), domain: varchar({ length: 32 }).notNull(),
  kind: varchar({ length: 16 }).default('action').notNull(), description: varchar({ length: 128 }).notNull(),
}, table => [primaryKey({ columns: [table.key], name: "permissions_key" })]);

export const rolePermissions = mysqlTable("role_permissions", {
  roleId: asciiId("role_id").notNull(), permissionKey: varchar("permission_key", { length: 64 }).notNull(),
}, table => [primaryKey({ columns: [table.roleId, table.permissionKey], name: "role_permissions_pk" }),
  foreignKey({ name: "fk_role_permissions_role", columns: [table.roleId], foreignColumns: [roles.id] }).onDelete("restrict").onUpdate("no action"),
  foreignKey({ name: "fk_role_permissions_permission", columns: [table.permissionKey], foreignColumns: [permissions.key] }).onDelete("restrict").onUpdate("no action")]);

export const roleBindings = mysqlTable("role_bindings", {
  id: asciiId().notNull(), roleId: asciiId("role_id").notNull(), principalType: varchar("principal_type", { length: 24 }).notNull(),
  principalId: asciiId("principal_id").notNull(), scopeType: varchar("scope_type", { length: 16 }).default('global').notNull(),
  scopeId: asciiVarchar("scope_id", { length: 26 }).default('').notNull(),
  createdAt: datetime("created_at", { mode: 'string', fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [primaryKey({ columns: [table.id], name: "role_bindings_id" }),
  unique("uk_role_bindings").on(table.roleId, table.principalType, table.principalId, table.scopeType, table.scopeId),
  index("idx_role_bindings_principal").on(table.principalType, table.principalId),
  foreignKey({ name: "fk_role_bindings_role", columns: [table.roleId], foreignColumns: [roles.id] }).onDelete("restrict").onUpdate("no action")]);


const jobConfigColumns = () => ({
  id: asciiId().notNull(), key: asciiVarchar({ length: 64 }).notNull(), name: varchar({ length: 128 }).notNull(),
  description: varchar({ length: 1024 }).default("").notNull(), ownerOrgUnitId: asciiId("owner_org_unit_id"), createdBy: asciiId("created_by"),
  revision: int({ unsigned: true }).default(1).notNull(), status: identityVarchar({ length: 16 }).default("disabled").notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
});
export const jobDefinitions = mysqlTable("job_definitions", {
  ...jobConfigColumns(), businessType: identityVarchar("business_type", { length: 64 }).notNull(), responsibleUserId: asciiId("responsible_user_id"),
  draftJson: json("draft_json").notNull(), publishedVersionId: asciiId("published_version_id"), nextVersion: int("next_version", { unsigned: true }).default(1).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_definitions_key").on(table.key),
  index("idx_job_definitions_org").on(table.ownerOrgUnitId, table.status, table.id),
  check("ck_job_definitions_status", sql`${table.status} IN ('active','disabled','deleted')`), check("ck_job_definitions_revision", sql`${table.revision} > 0 AND ${table.nextVersion} > 0`)]);
export const jobDefinitionVersions = mysqlTable("job_definition_versions", {
  id: asciiId().notNull(), jobId: asciiId("job_id").notNull(), version: int({ unsigned: true }).notNull(), manifestJson: json("manifest_json").notNull(),
  manifestHash: asciiChar("manifest_hash", { length: 64 }).notNull(), policyJson: json("policy_json").notNull(), inputSchemaJson: json("input_schema_json").notNull(), outputSchemaJson: json("output_schema_json").notNull(),
  publishedBy: asciiId("published_by"), createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_definition_versions").on(table.jobId, table.version),
  foreignKey({ name: "fk_job_versions_job", columns: [table.jobId], foreignColumns: [jobDefinitions.id] }).onDelete("restrict"), check("ck_job_version_positive", sql`${table.version} > 0`)]);
export const jobAppGrants = mysqlTable("job_app_grants", {
  id: asciiId().notNull(), jobId: asciiId("job_id").notNull(), appId: asciiId("app_id").notNull(), actionsJson: json("actions_json").notNull(),
  status: identityVarchar({ length: 16 }).default("active").notNull(), revision: int({ unsigned: true }).default(1).notNull(), createdBy: asciiId("created_by"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_app_grants").on(table.jobId, table.appId),
  index("idx_job_app_grants_app").on(table.appId, table.status, table.jobId),
  foreignKey({ name: "fk_job_grants_job", columns: [table.jobId], foreignColumns: [jobDefinitions.id] }).onDelete("restrict"),
  foreignKey({ name: "fk_job_grants_app", columns: [table.appId], foreignColumns: [apiApps.id] }).onDelete("restrict"),
  check("ck_job_grant_status", sql`${table.status} IN ('active','disabled')`)]);
export const jobExecutions = mysqlTable("job_executions", {
  id: asciiId().notNull(), jobId: asciiId("job_id").notNull(), jobVersionId: asciiId("job_version_id").notNull(), ownerOrgUnitId: asciiId("owner_org_unit_id"),
  subjectType: identityVarchar("subject_type", { length: 16 }).notNull(), subjectId: asciiId("subject_id").notNull(), appId: asciiId("app_id"),
  triggerType: identityVarchar("trigger_type", { length: 16 }).notNull(), triggerRef: varchar("trigger_ref", { length: 128 }), triggerActorJson: json("trigger_actor_json").notNull(),
  businessType: identityVarchar("business_type", { length: 64 }).notNull(), businessObjectId: varchar("business_object_id", { length: 128 }).notNull(), businessPeriod: identityVarchar("business_period", { length: 64 }),
  businessRefJson: json("business_ref_json").notNull(), businessKeyHash: asciiChar("business_key_hash", { length: 64 }).notNull(), inputHash: asciiChar("input_hash", { length: 64 }).notNull(),
  round: int({ unsigned: true }).default(1).notNull(), retryOfExecutionId: asciiId("retry_of_execution_id"), runtimeEngine: identityVarchar("runtime_engine", { length: 24 }).notNull(), snapshotQuality: identityVarchar("snapshot_quality", { length: 16 }).notNull(),
  generation: int({ unsigned: true }).default(1).notNull(), stateRevision: int("state_revision", { unsigned: true }).default(1).notNull(),
  status: identityVarchar({ length: 24 }).default("queued").notNull(), waitReason: identityVarchar("wait_reason", { length: 24 }), requestedAction: identityVarchar("requested_action", { length: 16 }),
  inputJson: json("input_json"), snapshotJson: json("snapshot_json"), outputJson: json("output_json"),
  totalCount: int("total_count", { unsigned: true }), succeededCount: int("succeeded_count", { unsigned: true }).default(0).notNull(), failedCount: int("failed_count", { unsigned: true }).default(0).notNull(), unknownCount: int("unknown_count", { unsigned: true }).default(0).notNull(), skippedCount: int("skipped_count", { unsigned: true }).default(0).notNull(),
  activeMs: bigint("active_ms", { mode: "bigint", unsigned: true }).default(sql`0`).notNull(), activeSince: datetime("active_since", { mode: "string", fsp: 3 }), activeSegmentCount: int("active_segment_count", { unsigned: true }).default(0).notNull(), activeBudgetSeconds: int("active_budget_seconds", { unsigned: true }).notNull(), waitDeadlineAt: datetime("wait_deadline_at", { mode: "string", fsp: 3 }), nextWakeAt: datetime("next_wake_at", { mode: "string", fsp: 3 }),
  costUsd: decimal("cost_usd", { precision: 12, scale: 6 }).default("0").notNull(), reservedCostUsd: decimal("reserved_cost_usd", { precision: 12, scale: 6 }).default("0").notNull(), costLimitUsd: decimal("cost_limit_usd", { precision: 12, scale: 6 }).notNull(),
  deliveryStatus: identityVarchar("delivery_status", { length: 24 }).default("not_applicable").notNull(), qualityStatus: identityVarchar("quality_status", { length: 16 }).default("not_checked").notNull(), deliveryRevision: int("delivery_revision", { unsigned: true }).default(1).notNull(), deliveryEvidenceJson: json("delivery_evidence_json"),
  nextEventSeq: bigint("next_event_seq", { mode: "bigint", unsigned: true }).default(sql`1`).notNull(), claimedBy: identityVarchar("claimed_by", { length: 128 }), leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }), fenceToken: bigint("fence_token", { mode: "bigint", unsigned: true }).default(sql`0`).notNull(),
  errorCode: identityVarchar("error_code", { length: 16 }), errorMessage: varchar("error_message", { length: 512 }),
  startedAt: datetime("started_at", { mode: "string", fsp: 3 }), completedAt: datetime("completed_at", { mode: "string", fsp: 3 }), payloadPurgedAt: datetime("payload_purged_at", { mode: "string", fsp: 3 }),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(), updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_execution_business").on(table.jobId, table.businessKeyHash, table.round),
  foreignKey({ name: "fk_job_execution_job", columns: [table.jobId], foreignColumns: [jobDefinitions.id] }).onDelete("restrict"),
  foreignKey({ name: "fk_job_execution_version", columns: [table.jobVersionId], foreignColumns: [jobDefinitionVersions.id] }).onDelete("restrict"),
  index("idx_job_executions_due").on(table.status, table.nextWakeAt, table.id), index("idx_job_executions_lease").on(table.status, table.leaseExpiresAt, table.id),
  index("idx_job_executions_org").on(table.ownerOrgUnitId, table.createdAt, table.id), index("idx_job_executions_subject").on(table.subjectType, table.subjectId, table.createdAt, table.id),
  index("idx_job_executions_app").on(table.appId, table.createdAt, table.id), index("idx_job_executions_job").on(table.jobId, table.createdAt, table.id),
  index("idx_job_executions_business").on(table.ownerOrgUnitId, table.businessType, table.businessObjectId, table.createdAt, table.id), index("idx_job_executions_delivery").on(table.deliveryStatus, table.updatedAt, table.id),
  check("ck_job_execution_status", sql`${table.status} IN ('queued','running','waiting','pausing','paused','cancelling','succeeded','partial','failed','cancelled','skipped')`),
  check("ck_job_execution_subject", sql`${table.subjectType} IN ('user','service','app') AND (${table.subjectType} <> 'app' OR (${table.appId} IS NOT NULL AND ${table.appId} = ${table.subjectId}))`),
  check("ck_job_execution_engine", sql`(${table.runtimeEngine} = 'mysql-agent-bridge' AND ${table.snapshotQuality} = 'legacy') OR (${table.runtimeEngine} = 'temporal-job-v1' AND ${table.snapshotQuality} = 'frozen')`),
  check("ck_job_execution_wait", sql`(${table.status} <> 'waiting' OR ${table.waitReason} IS NOT NULL) AND (${table.waitReason} IS NULL OR ${table.waitReason} IN ('approval','human','external','reconcile','resource','budget','previous_execution'))`),
  check("ck_job_execution_counts", sql`${table.generation} BETWEEN 1 AND 4 AND ${table.round} > 0 AND ${table.stateRevision} > 0 AND ${table.costUsd} >= 0 AND ${table.reservedCostUsd} >= 0 AND ${table.costLimitUsd} > 0`),
  check("ck_job_execution_payload", sql`(${table.inputJson} IS NOT NULL AND ${table.snapshotJson} IS NOT NULL) OR (${table.payloadPurgedAt} IS NOT NULL AND ${table.status} IN ('succeeded','partial','failed','cancelled','skipped'))`),
  check("ck_job_execution_trigger", sql`${table.triggerType} IN ('manual','schedule','api','evaluation')`),
  check("ck_job_execution_action", sql`${table.requestedAction} IS NULL OR ${table.requestedAction} IN ('pause','cancel')`),
  check("ck_job_execution_quality", sql`${table.qualityStatus} IN ('not_checked','pass','fail','review')`),
  check("ck_job_execution_delivery", sql`${table.deliveryStatus} IN ('not_applicable','pending','delivered','blocked','waived')`)]);
export const jobSteps = mysqlTable("job_steps", {
  id: asciiId().notNull(), executionId: asciiId("execution_id").notNull(), stepKey: identityVarchar("step_key", { length: 64 }).notNull(), itemKey: varchar("item_key", { length: 128 }).default("").notNull(), itemHash: asciiChar("item_hash", { length: 64 }).notNull(), iteration: int({ unsigned: true }).default(0).notNull(), kind: identityVarchar({ length: 24 }).notNull(),
  generation: int({ unsigned: true }).default(1).notNull(), stateRevision: int("state_revision", { unsigned: true }).default(1).notNull(), status: identityVarchar({ length: 24 }).default("blocked").notNull(), waitReason: identityVarchar("wait_reason", { length: 24 }), errorCode: identityVarchar("error_code", { length: 16 }), errorMessage: varchar("error_message", { length: 512 }),
  dependsOnJson: json("depends_on_json").notNull(), inputHash: asciiChar("input_hash", { length: 64 }).notNull(), inputJson: json("input_json"), resultJson: json("result_json"), resultFileId: asciiId("result_file_id"), readOnly: tinyint("read_only").notNull(), sideEffectState: identityVarchar("side_effect_state", { length: 16 }).default("not_submitted").notNull(),
  currentAttemptNo: int("current_attempt_no", { unsigned: true }).default(0).notNull(), successfulAttemptId: asciiId("successful_attempt_id"), availableAt: datetime("available_at", { mode: "string", fsp: 3 }), startedAt: datetime("started_at", { mode: "string", fsp: 3 }), completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(), updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_steps").on(table.executionId, table.stepKey, table.itemHash, table.iteration),
  foreignKey({ name: "fk_job_step_execution", columns: [table.executionId], foreignColumns: [jobExecutions.id] }).onDelete("restrict"),
  index("idx_job_steps_ready").on(table.executionId, table.status, table.availableAt, table.id), index("idx_job_steps_result").on(table.resultFileId),
  check("ck_job_step_status", sql`${table.status} IN ('blocked','ready','dispatched','running','waiting','succeeded','failed','cancelled','skipped')`),
  check("ck_job_step_kind", sql`${table.kind} IN ('agent','domain','script','browser','external','human','gate','condition','map','join')`),
  check("ck_job_step_effect", sql`${table.sideEffectState} IN ('not_submitted','submitted','confirmed','unknown')`)]);
export const jobStepAttempts = mysqlTable("job_step_attempts", {
  id: asciiId().notNull(), stepId: asciiId("step_id").notNull(), attemptNo: int("attempt_no", { unsigned: true }).notNull(), generation: int({ unsigned: true }).notNull(), dispatchKey: asciiChar("dispatch_key", { length: 64 }).notNull(), status: identityVarchar({ length: 24 }).default("prepared").notNull(), sideEffectState: identityVarchar("side_effect_state", { length: 16 }).default("not_submitted").notNull(),
  fenceToken: bigint("fence_token", { mode: "bigint", unsigned: true }).notNull(), claimedBy: identityVarchar("claimed_by", { length: 128 }), leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }), runId: asciiId("run_id"), codeExecutionId: asciiId("code_execution_id"), externalOperationId: varchar("external_operation_id", { length: 128 }), requestHash: asciiChar("request_hash", { length: 64 }).notNull(), resultHash: asciiChar("result_hash", { length: 64 }), lastResultMessageId: identityVarchar("last_result_message_id", { length: 64 }), inputFileId: asciiId("input_file_id"), resultJson: json("result_json"), resultFileId: asciiId("result_file_id"), errorCode: identityVarchar("error_code", { length: 16 }), errorMessage: varchar("error_message", { length: 512 }),
  submittedAt: datetime("submitted_at", { mode: "string", fsp: 3 }), confirmedAt: datetime("confirmed_at", { mode: "string", fsp: 3 }), completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(), updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_job_step_attempt").on(table.stepId, table.attemptNo), unique("uk_job_dispatch_key").on(table.dispatchKey),
  foreignKey({ name: "fk_job_attempt_step", columns: [table.stepId], foreignColumns: [jobSteps.id] }).onDelete("restrict"),
  index("idx_job_step_attempts_lease").on(table.status, table.leaseExpiresAt, table.id), index("idx_job_step_attempts_run").on(table.runId), index("idx_job_step_attempts_external").on(table.externalOperationId),
  check("ck_job_attempt_status", sql`${table.status} IN ('prepared','submitted','running','succeeded','failed','unknown','cancelled')`),
  check("ck_job_attempt_effect", sql`${table.sideEffectState} IN ('not_submitted','submitted','confirmed','unknown')`), check("ck_job_attempt_number", sql`${table.attemptNo} > 0 AND ${table.generation} BETWEEN 1 AND 4`)]);
export const jobEvents = mysqlTable("job_events", {
  executionId: asciiId("execution_id").notNull(), seq: bigint({ mode: "bigint", unsigned: true }).notNull(), eventId: identityVarchar("event_id", { length: 64 }).notNull(), generation: int({ unsigned: true }).notNull(), type: identityVarchar({ length: 64 }).notNull(), dataJson: json("data_json").notNull(), createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [primaryKey({ columns: [table.executionId, table.seq] }), unique("uk_job_event_id").on(table.eventId), index("idx_job_events_created").on(table.createdAt, table.executionId, table.seq)]);
export const outboxEvents = mysqlTable("outbox_events", {
  id: asciiId().notNull(), topic: identityVarchar({ length: 64 }).notNull(), eventId: identityVarchar("event_id", { length: 64 }).notNull(), sourceType: identityVarchar("source_type", { length: 32 }).notNull(), sourceId: asciiId("source_id").notNull(), sourceSeq: bigint("source_seq", { mode: "bigint", unsigned: true }).notNull(), ownerOrgUnitId: asciiId("owner_org_unit_id"), policyJson: json("policy_json").notNull(), targetsJson: json("targets_json").notNull(), payloadJson: json("payload_json").notNull(), status: identityVarchar({ length: 16 }).default("pending").notNull(), attempts: int({ unsigned: true }).default(0).notNull(), availableAt: datetime("available_at", { mode: "string", fsp: 3 }).notNull(), claimedBy: identityVarchar("claimed_by", { length: 128 }), leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }), fenceToken: bigint("fence_token", { mode: "bigint", unsigned: true }).default(sql`0`).notNull(), errorCode: identityVarchar("error_code", { length: 16 }), processedAt: datetime("processed_at", { mode: "string", fsp: 3 }), createdAt: datetime("created_at", { mode: "string", fsp: 3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
}, table => [primaryKey({ columns: [table.id] }), unique("uk_outbox_event").on(table.topic, table.eventId), index("idx_outbox_due").on(table.status, table.availableAt, table.id), index("idx_outbox_lease").on(table.status, table.leaseExpiresAt, table.id), index("idx_outbox_source").on(table.sourceType, table.sourceId, table.sourceSeq),
  check("ck_outbox_topic", sql`${table.topic} IN ('job.start','job.wake','run.start','message.fanout')`), check("ck_outbox_status", sql`${table.status} IN ('pending','claimed','processed','failed')`)]);

export const messageChannels=mysqlTable("message_channels", {
  ...jobConfigColumns(),
  type: identityVarchar("type", { length:16 }).notNull(),
  publishedVersionId: asciiId("published_version_id"),
  nextVersion: int("next_version", { unsigned:true }).default(1).notNull(),
  legacyAppId: asciiId("legacy_app_id"),
  credentialOwnerType: identityVarchar("credential_owner_type", { length:24 }).notNull(),
  credentialOwnerId: asciiId("credential_owner_id").notNull(),
  dispatchEpoch: bigint("dispatch_epoch", { mode:"bigint", unsigned:true }).default(sql`1`).notNull()
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_channels_key").on(table.key),
  unique("uk_message_channels_legacy").on(table.legacyAppId),
  index("idx_message_channels_org").on(table.ownerOrgUnitId,table.status,table.id),
  foreignKey({ name:"fk_message_channels_0", columns:[table.legacyAppId], foreignColumns:[apiApps.id] }).onDelete("restrict"),
  check("ck_message_channels_status",sql`${table.status} IN ('active','disabled','deleted')`),
  check("ck_message_channels_type",sql`${table.type} IN ('webhook','wecom')`),
  check("ck_message_channels_owner",sql`(${table.legacyAppId} IS NULL AND ${table.credentialOwnerType}='message_channel' AND ${table.credentialOwnerId}=${table.id}) OR (${table.legacyAppId} IS NOT NULL AND ${table.credentialOwnerType}='api_app' AND ${table.credentialOwnerId}=${table.legacyAppId})`)
]);

export const messageChannelVersions=mysqlTable("message_channel_versions", {
  id:asciiId().notNull(),
  createdAt:datetime("created_at", { mode:"string",fsp:3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  channelId: asciiId("channel_id").notNull(),
  version: int("version", { unsigned:true }).notNull(),
  endpointSecretId: asciiId("endpoint_secret_id").notNull(),
  signingSecretId: asciiId("signing_secret_id"),
  headerRefsJson: json("header_refs_json").notNull(),
  endpointFingerprint: asciiChar("endpoint_fingerprint", { length:64 }).notNull(),
  transportJson: json("transport_json").notNull(),
  mentionedIdsJson: json("mentioned_ids_json").notNull(),
  mentionedMobilesJson: json("mentioned_mobiles_json").notNull(),
  createdBy: asciiId("created_by")
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_channel_versions").on(table.channelId,table.version),
  foreignKey({ name:"fk_message_channel_versions_0", columns:[table.channelId], foreignColumns:[messageChannels.id] }).onDelete("restrict"),
  foreignKey({ name:"fk_message_channel_versions_1", columns:[table.endpointSecretId], foreignColumns:[secrets.id] }).onDelete("restrict"),
  foreignKey({ name:"fk_message_channel_versions_2", columns:[table.signingSecretId], foreignColumns:[secrets.id] }).onDelete("restrict")
]);

export const messageTemplates=mysqlTable("message_templates", {
  ...jobConfigColumns(),
  draftJson: json("draft_json").notNull(),
  publishedVersionId: asciiId("published_version_id"),
  nextVersion: int("next_version", { unsigned:true }).default(1).notNull()
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_templates_key").on(table.key),
  index("idx_message_templates_org").on(table.ownerOrgUnitId,table.status,table.id),
  check("ck_message_templates_status",sql`${table.status} IN ('active','disabled','deleted')`)
]);

export const messageTemplateVersions=mysqlTable("message_template_versions", {
  id:asciiId().notNull(),
  createdAt:datetime("created_at", { mode:"string",fsp:3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  templateId: asciiId("template_id").notNull(),
  version: int("version", { unsigned:true }).notNull(),
  format: identityVarchar("format", { length:24 }).notNull(),
  content: text("content").notNull(),
  variablesJson: json("variables_json").notNull(),
  contentHash: asciiChar("content_hash", { length:64 }).notNull(),
  createdBy: asciiId("created_by")
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_template_versions").on(table.templateId,table.version),
  foreignKey({ name:"fk_message_template_versions_0", columns:[table.templateId], foreignColumns:[messageTemplates.id] }).onDelete("restrict"),
  check("ck_message_template_versions_format",sql`${table.format}='wecom_text'`)
]);

export const messageRules=mysqlTable("message_rules", {
  ...jobConfigColumns(),
  eventType: identityVarchar("event_type", { length:64 }).notNull(),
  scopeType: identityVarchar("scope_type", { length:16 }).notNull(),
  scopeId: asciiId("scope_id"),
  channelId: asciiId("channel_id").notNull(),
  templateVersionId: asciiId("template_version_id"),
  includeNestedRuns: tinyint("include_nested_runs").default(0).notNull()
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_rules_key").on(table.key),
  index("idx_message_rules_match").on(table.eventType,table.status,table.ownerOrgUnitId,table.scopeType,table.scopeId),
  foreignKey({ name:"fk_message_rules_0", columns:[table.channelId], foreignColumns:[messageChannels.id] }).onDelete("restrict"),
  foreignKey({ name:"fk_message_rules_1", columns:[table.templateVersionId], foreignColumns:[messageTemplateVersions.id] }).onDelete("restrict"),
  check("ck_message_rules_status",sql`${table.status} IN ('active','disabled','deleted')`),
  check("ck_message_rules_scope",sql`(${table.scopeType}='global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('job','agent','api_app','org') AND ${table.scopeId} IS NOT NULL)`)
]);

export const messageDeliveries=mysqlTable("message_deliveries", {
  id:asciiId().notNull(),
  createdAt:datetime("created_at", { mode:"string",fsp:3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  eventId: identityVarchar("event_id", { length:64 }).notNull(),
  eventType: identityVarchar("event_type", { length:64 }).notNull(),
  sourceType: identityVarchar("source_type", { length:32 }).notNull(),
  sourceId: asciiId("source_id").notNull(),
  sourceGeneration: int("source_generation", { unsigned:true }).default(1).notNull(),
  ownerOrgUnitId: asciiId("owner_org_unit_id"),
  subjectType: identityVarchar("subject_type", { length:16 }).notNull(),
  subjectId: asciiId("subject_id").notNull(),
  appId: asciiId("app_id"),
  channelId: asciiId("channel_id").notNull(),
  channelVersionId: asciiId("channel_version_id").notNull(),
  matchedRulesJson: json("matched_rules_json").notNull(),
  templateVersionId: asciiId("template_version_id"),
  payloadBody: bufferColumn("payload_body", { sqlType:"mediumblob" }),
  payloadHash: asciiChar("payload_hash", { length:64 }).notNull(),
  status: identityVarchar("status", { length:24 }).default("queued").notNull(),
  holdReason: identityVarchar("hold_reason", { length:32 }),
  cancelRequested: tinyint("cancel_requested").default(0).notNull(),
  stateRevision: int("state_revision", { unsigned:true }).default(1).notNull(),
  sendCycle: int("send_cycle", { unsigned:true }).default(1).notNull(),
  cycleAttempts: int("cycle_attempts", { unsigned:true }).default(0).notNull(),
  totalAttempts: int("total_attempts", { unsigned:true }).default(0).notNull(),
  nextAttemptAt: datetime("next_attempt_at", { mode:"string", fsp:3 }),
  claimedBy: identityVarchar("claimed_by", { length:128 }),
  leaseExpiresAt: datetime("lease_expires_at", { mode:"string", fsp:3 }),
  fenceToken: bigint("fence_token", { mode:"bigint", unsigned:true }).default(sql`0`).notNull(),
  authorizedEpoch: bigint("authorized_epoch", { mode:"bigint", unsigned:true }).default(sql`0`).notNull(),
  historicalTargetAck: tinyint("historical_target_ack").default(0).notNull(),
  firstDeliveredAt: datetime("first_delivered_at", { mode:"string", fsp:3 }),
  lastDeliveredAt: datetime("last_delivered_at", { mode:"string", fsp:3 }),
  lastErrorCode: identityVarchar("last_error_code", { length:16 }),
  legacyDeliveryId: asciiId("legacy_delivery_id"),
  legacyAttempts: int("legacy_attempts", { unsigned:true }).default(0).notNull(),
  payloadPurgedAt: datetime("payload_purged_at", { mode:"string", fsp:3 }),
  updatedAt: datetime("updated_at", { mode:"string", fsp:3 }).default(sql`(CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3)`).notNull()
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_event_channel").on(table.eventId,table.channelId),
  unique("uk_message_legacy_delivery").on(table.legacyDeliveryId),
  index("idx_message_deliveries_due").on(table.status,table.nextAttemptAt,table.id),
  index("idx_message_deliveries_org").on(table.ownerOrgUnitId,table.createdAt,table.id),
  index("idx_message_deliveries_source").on(table.sourceType,table.sourceId,table.createdAt,table.id),
  index("idx_message_deliveries_channel").on(table.channelId,table.createdAt,table.id),
  foreignKey({ name:"fk_message_deliveries_0", columns:[table.channelId], foreignColumns:[messageChannels.id] }).onDelete("restrict"),
  foreignKey({ name:"fk_message_deliveries_1", columns:[table.channelVersionId], foreignColumns:[messageChannelVersions.id] }).onDelete("restrict"),
  check("ck_message_deliveries_status",sql`${table.status} IN ('queued','sending','retry_wait','delivered','failed','unknown','held','cancelled')`),
  check("ck_message_deliveries_payload",sql`${table.payloadBody} IS NOT NULL OR ${table.payloadPurgedAt} IS NOT NULL`),
  check("ck_message_deliveries_held",sql`${table.status}<>'held' OR ${table.holdReason} IS NOT NULL`),
  check("ck_message_deliveries_cycle",sql`${table.sendCycle}>0 AND ${table.stateRevision}>0`)
]);

export const messageDeliveryAttempts=mysqlTable("message_delivery_attempts", {
  id:asciiId().notNull(),
  createdAt:datetime("created_at", { mode:"string",fsp:3 }).default(sql`(CURRENT_TIMESTAMP(3))`).notNull(),
  deliveryId: asciiId("delivery_id").notNull(),
  attemptNo: int("attempt_no", { unsigned:true }).notNull(),
  sendCycle: int("send_cycle", { unsigned:true }).notNull(),
  status: identityVarchar("status", { length:16 }).default("prepared").notNull(),
  channelVersionId: asciiId("channel_version_id").notNull(),
  endpointFingerprint: asciiChar("endpoint_fingerprint", { length:64 }).notNull(),
  payloadHash: asciiChar("payload_hash", { length:64 }).notNull(),
  fenceToken: bigint("fence_token", { mode:"bigint", unsigned:true }).notNull(),
  submittedAt: datetime("submitted_at", { mode:"string", fsp:3 }),
  completedAt: datetime("completed_at", { mode:"string", fsp:3 }),
  responseStatus: int("response_status", { unsigned:true }),
  responseSummary: varchar("response_summary", { length:512 }),
  errorCode: identityVarchar("error_code", { length:16 }),
  retryAfterSeconds: int("retry_after_seconds", { unsigned:true }),
  uncertain: tinyint("uncertain").default(0).notNull()
},table=>[
  primaryKey({ columns:[table.id] }),
  unique("uk_message_delivery_attempt").on(table.deliveryId,table.attemptNo),
  index("idx_message_delivery_attempts_delivery").on(table.deliveryId,table.attemptNo),
  index("idx_message_delivery_attempts_due").on(table.status,table.createdAt,table.id),
  foreignKey({ name:"fk_message_delivery_attempts_0", columns:[table.deliveryId], foreignColumns:[messageDeliveries.id] }).onDelete("restrict"),
  check("ck_message_delivery_attempts_status",sql`${table.status} IN ('prepared','submitted','succeeded','failed','unknown')`),
  check("ck_message_delivery_attempts_number",sql`${table.attemptNo}>0 AND ${table.sendCycle}>0`)
]);
