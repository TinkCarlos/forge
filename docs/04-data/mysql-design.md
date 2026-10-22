# Forge MySQL 数据设计

版本：1.0　日期：2026-10-21　状态：待评审

> **MySQL 8.0.30+ 是 Forge 唯一系统数据库。** 不提供 SQLite/PostgreSQL 运行模式；开发、测试、生产统一使用 MySQL。Redis 与对象存储不是事实来源。

## 1. 环境与约定

| 项 | 约定 |
| --- | --- |
| 版本 | MySQL 8.0.30+（推荐 8.0.36+），InnoDB |
| 字符集 | `utf8mb4` / `utf8mb4_0900_ai_ci` |
| ID | ULID，`CHAR(26) CHARACTER SET ascii COLLATE ascii_bin`；资源前缀仅用于展示 |
| 时间 | `DATETIME(3)`，UTC；连接参数 `time_zone='+00:00'` |
| 布尔 | `TINYINT(1)` |
| 金额 | `DECIMAL(12,6)` USD |
| Token | `BIGINT UNSIGNED` |
| 枚举 | `VARCHAR(32)` + `CHECK` 约束（避免 ENUM 改值锁表） |
| JSON | MySQL `JSON`；应用层用 Zod 校验；高频查询字段建生成列+索引 |
| 并发控制 | 配置类资源带 `revision INT UNSIGNED`；更新 `WHERE revision=?` |
| 软删除 | 仅配置类资源；日志/事件不软删除，按保留期清理 |
| 外键 | 配置类核心关系使用 FK（`RESTRICT`）；日志/事件表不建 FK，便于分区与清理 |
| 命名 | 表 snake_case 复数；索引 `idx_表_字段`；唯一键 `uk_表_字段` |
| 事务隔离 | `READ-COMMITTED`（与 Temporal 要求一致，减少间隙锁） |
| SQL 模式 | `STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO` |
| 大小写 | 表名小写；Linux 下 `lower_case_table_names=1` 需在初始化前确定，生产保持 1 |

**数据库账户**

| 账户 | 权限 | 用途 |
| --- | --- | --- |
| `forge_app` | 业务表 SELECT/INSERT/UPDATE/DELETE | API、Worker |
| `forge_migrate` | DDL + DML | 迁移 Job，仅部署时使用 |
| `forge_readonly` | SELECT | 报表/排障，可选 |
| `temporal` | Temporal 库权限 | Temporal Server |

不使用 root；启用 TLS；生产禁止应用账户执行 DDL。

## 2. 存储分工

| 存储 | 内容 | 事实来源 |
| --- | --- | --- |
| MySQL `forge` | 配置、版本、Run、消息、工具调用、审批、审计、用量、密钥 | 是 |
| MySQL `forge_temporal` | Temporal 工作流历史与可见性 | 工作流状态 |
| Redis | SSE Stream、限流、缓存、BFF 会话、锁 | 否，可重建 |
| S3 | 文件、Artifact、能力包、大工具结果、知识库原文 | 文件内容 |
| Langfuse（可选） | 模型 Trace 可视化 | 否 |

Temporal 使用独立 database 与账户；不要与业务表混用。对象存储 key 规则：

```
forge-files/{orgId}/{yyyymm}/{fileId}/{name}
forge-artifacts/{runId}/{artifactId}/{name}
forge-packages/{packageKey}/{version}/{archive}
forge-tool-results/{runId}/{toolCallId}.json.gz
forge-kb/{kbId}/{documentId}/parsed.txt
```

## 3. 领域关系

```
sso_providers ─< sso_role_mappings >─ roles
org_units ─┬─< users ─< role_bindings >─ roles ─< role_permissions >─ permissions
           ├─< groups ─< group_members
           ├─< service_accounts ─< service_account_roles >─ roles
           ├─< data_scopes ─< data_scope_orgs
           ├─< data_policies >─ roles
           ├─< api_apps ─< api_keys / api_quotas / webhook_endpoints
           └─< plugin_installations >─ plugin_installation_versions >─ plugin_versions
agents ─< agent_versions ─< resource_references
agents ─< agent_bindings
threads ─< runs ─┬─< run_steps ─< tool_calls
                 ├─< messages
                 ├─< approvals
                 ├─< artifacts
                 ├─< run_events
                 └─ 1:1 run_policy_snapshots
schedules >── agents / service_accounts
llm_providers ─< llm_models ─< llm_routes（candidates JSON）
llm_usage_events / usage_daily
skills ─< skill_versions
mcp_servers ─< mcp_server_versions / mcp_tools / mcp_health_checks
tool_sources ─< tools
secrets ─< secret_versions ─< resource_references
connector_instances（本实例运行状态）
```

## 4. 表字典

### 4.1 组织与权限

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `org_units` | 组织树 | `id`, `parent_id`, `key`, `name`, `path`, `depth`, `sort_order`, `status` | `uk_org_units_key`; `idx_org_units_path`; `idx_org_units_parent` |
| `users` | 用户 | `id`, `username`, `email`, `display_name`, `primary_org_unit_id`, `idp_issuer`, `idp_subject`, `status`, `is_emergency_admin`, `last_login_at` | `uk_users_username`; `uk_users_email`; `uk_users_idp(issuer,subject)` |
| `groups` | 用户组 | `id`, `org_unit_id`, `key`, `name` | `uk_groups_key`; `idx_groups_org` |
| `group_members` | 组成员 | `group_id`, `user_id`, `created_at` | PK(`group_id`,`user_id`) |
| `roles` | 角色 | `id`, `key`, `name`, `builtin`, `description` | `uk_roles_key` |
| `permissions` | 功能权限目录 | `key`, `domain`, `kind`, `description` | PK(`key`) |
| `role_permissions` | 角色权限 | `role_id`, `permission_key` | PK(`role_id`,`permission_key`) |
| `role_bindings` | 角色绑定 | `id`, `role_id`, `principal_type`, `principal_id`, `scope_type`, `scope_id`, `created_at` | `uk_role_bindings`(role,principal,scope); `idx_role_bindings_principal` |
| `sso_providers` | SSO 提供方 | `id`, `key`, `name`, `source`, `issuer`, `client_id`, `secret_id`, `audience`, `scopes_json`, `mode`, `session_ttl_seconds`, `status` | `uk_sso_providers_key`; `idx_sso_providers_status` |
| `sso_role_mappings` | SSO 角色映射 | `id`, `provider_id`, `agent_role_code`, `agent_role_name`, `local_role_id`, `enabled` | `uk_sso_role_mappings(provider,code,name)` |
| `service_accounts` | 服务账号 | `id`, `key`, `name`, `description`, `source_system_id`, `org_unit_id`, `status`, `expires_at`, `created_by` | `uk_service_accounts_key`; `idx_service_accounts_status` |
| `service_account_roles` | 服务账号角色 | `id`, `service_account_id`, `role_id`, `scope_type`, `scope_id` | `uk_service_account_roles` |
| `connector_instances` | Connector 实例状态 | `id`, `instance_id`, `environment`, `connector_version`, `config_version`, `status`, `last_heartbeat_at`, `last_error_code` | `uk_connector_instances(environment,instance_id)` |

`org_units.path` 存 ULID 路径，例如 `/01JROOT/01JLEGAL/`；子树查询 `path LIKE '/01JROOT/01JLEGAL/%'`。`scope_type` 使用 `global`/`org`；`principal_type` 使用 `user`/`group`。

### 4.2 Agent 与 Skill

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `agents` | Agent 主记录 | `id`, `key`, `name`, `description`, `icon`, `category`, `status`, `owner_org_unit_id`, `latest_version_id`, `published_version_id`, `api_enabled`, `api_scopes_json`, `revision`, `created_by`, `deleted_at` | `uk_agents_key`; `idx_agents_org(status)`; `idx_agents_api(api_enabled,status)` |
| `agent_versions` | 不可变版本 | `id`, `agent_id`, `version`, `label`, `status`, `instructions`, `spec_json`, `changelog`, `checksum`, `created_by`, `published_at`, `deprecated_at` | `uk_agent_versions(agent_id,version)`; `idx_agent_versions_status` |
| `agent_bindings` | Agent 可见范围 | `agent_id`, `scope_type`, `scope_id`, `enabled` | `uk_agent_bindings`; `idx_agent_bindings_scope` |
| `skills` | Skill 主记录 | `id`, `key`, `name`, `description`, `status`, `latest_version_id`, `published_version_id`, `source_package_version_id`, `deleted_at` | `uk_skills_key`; `idx_skills_status` |
| `skill_versions` | Skill 版本 | `id`, `skill_id`, `version`, `status`, `content_md`, `frontmatter_json`, `assets_json`, `checksum`, `published_at` | `uk_skill_versions(skill_id,version)` |

`agents.latest_version_id` / `published_version_id` 是循环引用，使用应用层事务维护，不建 FK。已发布版本禁止 UPDATE `instructions/spec_json`（触发器可选，P0 由服务层保证 + 测试）。

### 4.3 插件与安装

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `plugin_packages` | 包主记录 | `id`, `key`, `name`, `vendor`, `type`, `description`, `status`, `created_by` | `uk_plugin_packages_key`; `idx_plugin_packages_type` |
| `plugin_versions` | 包版本 | `id`, `package_id`, `version`, `manifest_json`, `compatibility_json`, `config_schema_json`, `permissions_json`, `storage_key`, `checksum`, `signature`, `status`, `published_at` | `uk_plugin_versions(package_id,version)`; `idx_plugin_versions_status` |
| `plugin_dependencies` | 依赖声明 | `id`, `package_version_id`, `dep_type`, `dep_key`, `version_range`, `optional` | `idx_plugin_dependencies_pkg` |
| `plugin_installations` | 安装实例 | `id`, `package_id`, `scope_type`, `scope_id`, `status`, `active_version_id`, `config_json`, `installed_by`, `updated_at` | `uk_plugin_installations(package,scope_type,scope_id)`; `idx_plugin_installations_status` |
| `plugin_installation_versions` | 安装版本历史 | `id`, `installation_id`, `package_version_id`, `status`, `config_json`, `installed_at`, `activated_at`, `uninstalled_at` | `uk_plugin_installation_versions(installation,package_version)` |
| `plugin_installation_resources` | 安装创建的资源 | `installation_version_id`, `resource_type`, `resource_id`, `resource_key`, `resource_version_id` | `idx_plugin_installation_resources_resource` |
| `resource_references` | 资源引用/卸载保护 | `id`, `from_type`, `from_id`, `from_version_id`, `to_type`, `to_id`, `to_key`, `to_version`, `created_at` | `idx_resource_refs_to(to_type,to_key)`; `idx_resource_refs_from(from_type,from_id)` |

`scope_type` 为 `global`/`org`/`role`。`active_version_id` 指向 `plugin_installation_versions.id`；升级/回滚原子切换。`resource_references` 同时服务 Skill/MCP/工具/Provider/Secret 的引用检查。

### 4.4 MCP、工具与模型

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `mcp_servers` | MCP 服务 | `id`, `key`, `name`, `transport`, `config_json`, `current_version_id`, `status`, `health_status`, `last_checked_at`, `source_package_version_id`, `deleted_at` | `uk_mcp_servers_key`; `idx_mcp_servers_health` |
| `mcp_server_versions` | 配置版本 | `id`, `server_id`, `version`, `config_json`, `checksum`, `status`, `created_at` | `uk_mcp_versions(server_id,version)` |
| `mcp_tools` | 发现的工具 | `id`, `server_id`, `name`, `description`, `input_schema_json`, `annotations_json`, `risk_level`, `enabled`, `last_seen_at` | `uk_mcp_tools(server_id,name)`; `idx_mcp_tools_enabled` |
| `mcp_health_checks` | 健康历史 | `id`, `server_id`, `status`, `latency_ms`, `error_code`, `checked_at` | `idx_mcp_health(server_id,checked_at)` |
| `tool_sources` | OpenAPI/工具源 | `id`, `key`, `name`, `type`, `base_url`, `auth_type`, `secret_id`, `spec_storage_key`, `spec_json`, `version`, `status`, `source_package_version_id`, `deleted_at` | `uk_tool_sources_key`; `idx_tool_sources_status` |
| `tools` | 具体工具 | `id`, `source_id`, `name`, `operation_id`, `method`, `path`, `description`, `input_schema_json`, `risk_level`, `enabled` | `uk_tools(source_id,name)`; `idx_tools_enabled` |
| `llm_providers` | 模型供应商 | `id`, `key`, `name`, `protocol`, `base_url`, `auth_type`, `secret_id`, `headers_json`, `timeout_ms`, `tls_verify`, `is_builtin`, `status` | `uk_llm_providers_key`; `idx_llm_providers_status` |
| `llm_models` | 模型目录 | `id`, `provider_id`, `key`, `display_name`, `capabilities_json`, `context_window`, `max_output_tokens`, `input_price_per_mtok`, `output_price_per_mtok`, `cached_input_price_per_mtok`, `status` | `uk_llm_models(provider_id,key)`; `idx_llm_models_status` |
| `llm_routes` | 路由策略 | `id`, `key`, `name`, `strategy`, `candidates_json`, `conditions_json`, `status` | `uk_llm_routes_key` |
| `llm_health_checks` | Provider 健康 | `id`, `provider_id`, `status`, `latency_ms`, `error_code`, `checked_at` | `idx_llm_health(provider,checked_at)` |
| `llm_usage_events` | 每次模型调用 | `id`, `run_id`, `step_id`, `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `cost_usd`, `latency_ms`, `status`, `error_code`, `created_at` | PK(`id`,`created_at`)；按月分区；`idx_llm_usage_run` |

### 4.5 运行、消息与审批

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `threads` | 会话容器 | `id`, `agent_id`, `org_unit_id`, `subject_type`, `subject_id`, `title`, `next_seq`, `metadata_json`, `created_at`, `updated_at` | `idx_threads_subject`; `idx_threads_agent`; `idx_threads_org` |
| `runs` | 一次执行 | `id`, `thread_id`, `agent_id`, `agent_version_id`, `app_id`, `org_unit_id`, `subject_type`, `subject_id`, `status`, `trigger_type`, `trigger_ref`, `parent_run_id`, `input_json`, `output_json`, `output_storage_key`, `usage_json`, `cost_usd`, `error_code`, `error_message`, `policy_snapshot_id`, `cancel_requested`, `claimed_by`, `lease_expires_at`, `heartbeat_at`, `started_at`, `completed_at` | `idx_runs_status_created`; `idx_runs_lease(status,lease_expires_at)`; `idx_runs_agent_created`; `idx_runs_app_created`; `idx_runs_subject`; `idx_runs_org`; `idx_runs_trigger(trigger_type,trigger_ref)` |
| `run_steps` | 步骤时间线 | `id`, `run_id`, `seq`, `type`, `status`, `model_id`, `tool_call_id`, `summary_json`, `error_code`, `input_tokens`, `output_tokens`, `cost_usd`, `started_at`, `ended_at` | `uk_run_steps(run_id,seq)`; `idx_run_steps_type` |
| `messages` | 会话消息 | `id`, `thread_id`, `run_id`, `seq`, `role`, `content_json`, `created_at` | `uk_messages(thread_id,seq)`; `idx_messages_run` |
| `tool_calls` | 工具调用 | `id`, `run_id`, `step_id`, `tool_key`, `source_type`, `source_key`, `args_json`, `result_summary_json`, `result_storage_key`, `status`, `risk_level`, `approval_id`, `idempotency_key`, `attempt`, `error_code`, `started_at`, `ended_at`, `duration_ms` | `uk_tool_calls(run_id,idempotency_key)`; `idx_tool_calls_run`; `idx_tool_calls_tool` |
| `approvals` | 人工审批 | `id`, `run_id`, `tool_call_id`, `status`, `risk_level`, `policy_json`, `requested_at`, `expires_at`, `decided_by`, `decided_at`, `decision_comment`, `revision` | `idx_approvals_status_expires`; `idx_approvals_run` |
| `artifacts` | 产物 | `id`, `run_id`, `type`, `name`, `mime_type`, `size`, `storage_key`, `checksum`, `created_at` | `idx_artifacts_run` |
| `run_events` | 里程碑事件 | `run_id`, `seq`, `type`, `data_json`, `created_at` | PK(`run_id`,`seq`); `idx_run_events_created` |
| `run_policy_snapshots` | 策略快照 | `id`, `run_id`, `snapshot_json`, `policy_version`, `created_at` | `uk_policy_snapshot_run` |
| `idempotency_keys` | 创建类幂等 | `id`, `scope`, `key`, `request_hash`, `status_code`, `response_json`, `run_id`, `expires_at`, `created_at` | `uk_idempotency(scope,key)`; `idx_idempotency_expires` |
| `files` | 上传文件 | `id`, `owner_type`, `owner_id`, `storage_key`, `name`, `mime_type`, `size`, `checksum`, `status`, `expires_at`, `created_at` | `idx_files_owner`; `idx_files_expires` |

`messages.content_json` 为内容块数组（text/tool_call/tool_result/image_ref），大结果存对象存储。`seq` 按 Thread 全局递增，分配时在同一事务更新 `threads.next_seq`。`run_events` 的 `seq` 按 Run 递增。

**过渡调度列（Temporal 之前）**：`claimed_by`、`lease_expires_at`、`heartbeat_at` 只用于 MySQL 队列认领与崩溃续跑，不是业务事实来源。Worker 认领 `queued`，或租约已过期的 `running`；进入 `waiting_approval` 或 Run 结束后清空租约。接上 Temporal 后这三列停止写入，不在同一版本删除。

**0.1.x `run_steps`**：类型为 `prepare_context` / `compress` / `call_model` / `execute_tool` / `validate_output`。模型标识写入 `summary_json.modelKey`；目标字典中的 `model_id` 等外键留待模型目录接通后再填。`tool_calls.idempotency_key` 存 `runId:toolCallId`，与 `attempt` 一起用于崩溃后续跑时不重复插入已成功的调用。

**0.1.x 幂等与 Webhook**：`idempotency_keys.scope` 目前是 API App id，保留 24 小时。`webhook_deliveries.app_id` 指向应用上的单个 Webhook URL；目标设计里的 `webhook_endpoints` 尚未拆出，因此没有 `endpoint_id`。投递状态为 `pending` / `delivered` / `failed`。

### 4.6 开放平台与用量

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `api_apps` | 调用应用 | `id`, `key`, `name`, `description`, `owner_org_unit_id`, `status`, `scopes_json`, `revision`, `created_by` | `uk_api_apps_key`; `idx_api_apps_org` |
| `api_keys` | 密钥 | `id`, `app_id`, `name`, `prefix`, `key_hash BINARY(32)`, `scopes_json`, `status`, `expires_at`, `last_used_at`, `revoked_at` | `uk_api_keys_prefix`; `idx_api_keys_app` |
| `api_quotas` | 应用配额 | `app_id`, `rpm`, `concurrent_runs`, `daily_runs`, `monthly_runs`, `monthly_cost_usd`, `updated_at` | PK(`app_id`) |
| `webhook_endpoints` | Webhook 配置 | `id`, `app_id`, `url`, `secret_ciphertext`, `secret_key_version`, `events_json`, `status`, `failure_count`, `disabled_at` | `idx_webhooks_app`; `idx_webhooks_status` |
| `webhook_deliveries` | 投递记录 | `id`, `endpoint_id`, `event_id`, `event_type`, `payload_json`, `status`, `attempts`, `next_attempt_at`, `response_status`, `error_message`, `created_at`, `delivered_at` | `uk_webhook_delivery(endpoint,event)`; `idx_webhook_delivery_due(status,next_attempt_at)` |
| `api_request_logs` | 开放 API 访问日志 | `id`, `app_id`, `key_id`, `method`, `path`, `status_code`, `latency_ms`, `run_id`, `ip`, `user_agent`, `error_code`, `created_at` | PK(`id`,`created_at`)；按月分区；`idx_api_logs_app` |
| `usage_daily` | 用量聚合 | `date`, `scope_type`, `scope_id`, `runs`, `input_tokens`, `output_tokens`, `cost_usd`, `errors` | PK(`date`,`scope_type`,`scope_id`) |

`key_hash` 使用服务端 pepper 的 HMAC-SHA256；`prefix` 用于定位 Key（前 12–16 字符）。API Key 明文不落库。

### 4.7 治理、审计与通知

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `governance_policies` | 风险/审批/预算策略 | `id`, `key`, `name`, `type`, `rules_json`, `priority`, `status` | `uk_governance_policies_key`; `idx_policies_type` |
| `data_scopes` | 数据范围定义 | `id`, `key`, `name`, `type`, `config_json`, `description` | `uk_data_scopes_key`; `idx_data_scopes_type` |
| `data_scope_orgs` | 自定义组织范围 | `data_scope_id`, `org_unit_id` | PK(`data_scope_id`,`org_unit_id`) |
| `data_policies` | 角色数据策略 | `id`, `role_id`, `resource_type`, `actions_json`, `scope_id`, `effect`, `priority`, `revision` | `uk_data_policies(role,resource,scope,effect)`; `idx_data_policies_role` |
| `principal_data_grants` | 例外授权/拒绝 | `id`, `principal_type`, `principal_id`, `resource_type`, `actions_json`, `scope_id`, `effect`, `expires_at` | `idx_principal_grants_principal` |
| `resource_grants` | 单条资源共享（P1） | `id`, `resource_type`, `resource_id`, `principal_type`, `principal_id`, `actions_json`, `expires_at` | `uk_resource_grants`; `idx_resource_grants_resource` |
| `secrets` | 凭据主记录 | `id`, `key`, `name`, `scope_type`, `scope_id`, `active_version_id`, `status` | `uk_secrets_scope(scope_type,scope_id,key)` |
| `secret_versions` | 凭据密文版本 | `id`, `secret_id`, `version`, `ciphertext MEDIUMBLOB`, `nonce`, `tag`, `key_version`, `created_by`, `created_at` | `uk_secret_versions(secret_id,version)` |
| `audit_logs` | 审计 | `id`, `actor_type`, `actor_id`, `action`, `resource_type`, `resource_id`, `before_json`, `after_json`, `ip`, `user_agent`, `trace_id`, `request_id`, `created_at` | PK(`id`,`created_at`)；按月分区；`idx_audit_resource`; `idx_audit_actor` |
| `settings` | 系统设置 | `scope_type`, `scope_id`, `key`, `value_json`, `updated_by`, `updated_at` | PK(`scope_type`,`scope_id`,`key`) |
| `notifications` | 站内通知 | `id`, `user_id`, `type`, `title`, `body`, `resource_type`, `resource_id`, `read_at`, `created_at` | `idx_notifications_user(user_id,read_at)` |
| `outbox_events` | 可靠事件派发 | `id`, `topic`, `payload_json`, `status`, `attempts`, `available_at`, `created_at`, `processed_at` | `idx_outbox_due(status,available_at)` |

`audit_logs` 只追加；应用不提供更新/删除 API。合规删除通过分区 DROP 或归档流程完成。

### 4.8 知识库、定时任务与评测

| 表 | 用途 | 关键字段 | 索引 |
| --- | --- | --- | --- |
| `knowledge_bases` | 知识库（P1） | `id`, `key`, `name`, `org_unit_id`, `embedding_model_id`, `vector_store`, `chunking_json`, `status` | `uk_knowledge_bases_key`; `idx_kb_org` |
| `kb_documents` | 文档（P1） | `id`, `kb_id`, `file_id`, `name`, `status`, `error_code`, `parsed_storage_key`, `checksum` | `idx_kb_documents_kb` |
| `kb_chunks` | 分块（P1） | `id`, `document_id`, `seq`, `content`, `token_count`, `embedding BLOB`, `metadata_json` | `idx_kb_chunks_doc` |
| `agent_kb_bindings` | Agent 绑定（P1） | `agent_id`, `kb_id`, `retrieval_json` | PK(`agent_id`,`kb_id`) |
| `schedules` | 定时任务（P0） | `id`, `key`, `name`, `agent_id`, `service_account_id`, `org_unit_id`, `cron`, `timezone`, `input_json`, `version_policy`, `agent_version_id`, `concurrency_policy`, `max_cost_usd`, `status`, `next_run_at`, `last_run_id`, `failure_count`, `last_error_code`, `created_by` | `uk_schedules_key`; `idx_schedules_due(status,next_run_at)`; `idx_schedules_agent`; `idx_schedules_org` |
| `eval_datasets` | 数据集 | `id`, `key`, `name`, `description` | `uk_eval_datasets_key` |
| `eval_cases` | 用例 | `id`, `dataset_id`, `seq`, `input_json`, `expected_json`, `scoring_json` | `idx_eval_cases_dataset` |
| `eval_runs` | 评测运行 | `id`, `dataset_id`, `agent_version_id`, `status`, `metrics_json`, `cost_usd`, `started_at`, `completed_at` | `idx_eval_runs_dataset` |
| `eval_results` | 用例结果 | `id`, `eval_run_id`, `case_id`, `run_id`, `status`, `score`, `detail_json` | `idx_eval_results_run` |

知识库默认 `vector_store='mysql-exact'`（小规模，应用层余弦）；大规模可切 Qdrant 适配器，MySQL 仍保存文档、分块与元数据。

## 5. 核心 DDL

> 以下为核心表 DDL 示例。完整 DDL 由 `packages/store` 的 Drizzle schema 生成；字段、索引、约束必须与第 4 节表字典一致。迁移文件只追加，不修改历史。

### 5.1 Agent

```sql
CREATE TABLE agents (
  id                    CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key`                 VARCHAR(64)  NOT NULL,
  name                  VARCHAR(128) NOT NULL,
  description           VARCHAR(1024) NOT NULL DEFAULT '',
  icon                  VARCHAR(64)  NOT NULL DEFAULT '',
  category              VARCHAR(64)  NOT NULL DEFAULT '',
  status                VARCHAR(16)  NOT NULL DEFAULT 'active',
  owner_org_unit_id     CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  latest_version_id     CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  published_version_id  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  api_enabled           TINYINT(1)   NOT NULL DEFAULT 0,
  api_scopes_json       JSON         NULL,
  revision              INT UNSIGNED NOT NULL DEFAULT 1,
  created_by            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at            DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agents_key (`key`),
  KEY idx_agents_org (owner_org_unit_id, status),
  KEY idx_agents_api (api_enabled, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE agent_versions (
  id             CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id       CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version        VARCHAR(32)  NOT NULL,
  label          VARCHAR(64)  NOT NULL DEFAULT '',
  status         VARCHAR(16)  NOT NULL DEFAULT 'draft',
  instructions   MEDIUMTEXT   NOT NULL,
  spec_json      JSON         NOT NULL,
  changelog      VARCHAR(2048) NOT NULL DEFAULT '',
  checksum       CHAR(64)     NOT NULL,
  created_by     CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3)  NULL,
  deprecated_at  DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agent_versions (agent_id, version),
  KEY idx_agent_versions_status (agent_id, status),
  CONSTRAINT fk_agent_versions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 5.2 Run 与消息

```sql
CREATE TABLE runs (
  id                 CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thread_id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id           CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_version_id   CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_id             CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  org_unit_id        CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subject_type       VARCHAR(16) NOT NULL,
  subject_id         CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status             VARCHAR(24) NOT NULL,
  trigger_type       VARCHAR(16) NOT NULL,
  trigger_ref        VARCHAR(128) NULL,
  parent_run_id      CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  input_json         JSON NOT NULL,
  output_json        JSON NULL,
  output_storage_key VARCHAR(512) NULL,
  usage_json         JSON NULL,
  cost_usd           DECIMAL(12,6) NOT NULL DEFAULT 0,
  error_code         VARCHAR(16) NULL,
  error_message      VARCHAR(1024) NULL,
  policy_snapshot_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  started_at         DATETIME(3) NULL,
  completed_at       DATETIME(3) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_runs_status_created (status, created_at),
  KEY idx_runs_agent_created (agent_id, created_at),
  KEY idx_runs_app_created (app_id, created_at),
  KEY idx_runs_subject (subject_type, subject_id, created_at),
  KEY idx_runs_org (org_unit_id, created_at),
  KEY idx_runs_trigger (trigger_type, trigger_ref, created_at),
  CONSTRAINT fk_runs_thread FOREIGN KEY (thread_id) REFERENCES threads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_runs_agent_version FOREIGN KEY (agent_version_id) REFERENCES agent_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE messages (
  id           CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thread_id    CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id       CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  seq          BIGINT UNSIGNED NOT NULL,
  role         VARCHAR(16) NOT NULL,
  content_json JSON NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_messages_thread_seq (thread_id, seq),
  KEY idx_messages_run (run_id),
  CONSTRAINT fk_messages_thread FOREIGN KEY (thread_id) REFERENCES threads (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 5.3 工具调用与审批

```sql
CREATE TABLE tool_calls (
  id                   CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id               CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  step_id              CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tool_key             VARCHAR(128) NOT NULL,
  source_type          VARCHAR(16) NOT NULL,
  source_key           VARCHAR(64) NOT NULL,
  args_json            JSON NOT NULL,
  result_summary_json  JSON NULL,
  result_storage_key   VARCHAR(512) NULL,
  status               VARCHAR(16) NOT NULL,
  risk_level           VARCHAR(16) NOT NULL,
  approval_id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idempotency_key      VARCHAR(96) NOT NULL,
  attempt              INT UNSIGNED NOT NULL DEFAULT 1,
  error_code           VARCHAR(16) NULL,
  started_at           DATETIME(3) NULL,
  ended_at             DATETIME(3) NULL,
  duration_ms          INT UNSIGNED NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_tool_calls_idem (run_id, idempotency_key),
  KEY idx_tool_calls_run (run_id, created_at),
  KEY idx_tool_calls_tool (tool_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE approvals (
  id               CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id           CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tool_call_id     CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  risk_level       VARCHAR(16) NOT NULL,
  policy_json      JSON NULL,
  requested_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at       DATETIME(3) NOT NULL,
  decided_by       CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  decided_at       DATETIME(3) NULL,
  decision_comment VARCHAR(1024) NULL,
  revision         INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_approvals_status_expires (status, expires_at),
  KEY idx_approvals_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 5.4 插件安装

```sql
CREATE TABLE plugin_installations (
  id                  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  package_id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_type          VARCHAR(16) NOT NULL,
  scope_id            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status              VARCHAR(24) NOT NULL,
  active_version_id   CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  config_json         JSON NULL,
  installed_by        CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_plugin_installations (package_id, scope_type, scope_id),
  KEY idx_plugin_installations_status (status),
  CONSTRAINT fk_installations_package FOREIGN KEY (package_id) REFERENCES plugin_packages (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 5.5 开放平台

```sql
CREATE TABLE api_apps (
  id                 CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key`               VARCHAR(64) NOT NULL,
  name               VARCHAR(128) NOT NULL,
  description        VARCHAR(1024) NOT NULL DEFAULT '',
  owner_org_unit_id  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'active',
  scopes_json        JSON NOT NULL,
  revision           INT UNSIGNED NOT NULL DEFAULT 1,
  created_by         CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_api_apps_key (`key`),
  KEY idx_api_apps_org (owner_org_unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE api_keys (
  id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_id      CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name        VARCHAR(128) NOT NULL,
  prefix      VARCHAR(20) NOT NULL,
  key_hash    BINARY(32) NOT NULL,
  scopes_json JSON NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'active',
  expires_at  DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at  DATETIME(3) NULL,
  created_by  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_api_keys_prefix (prefix),
  KEY idx_api_keys_app (app_id, status),
  CONSTRAINT fk_api_keys_app FOREIGN KEY (app_id) REFERENCES api_apps (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 5.6 审计分区示例

```sql
CREATE TABLE audit_logs (
  id            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_type    VARCHAR(16) NOT NULL,
  actor_id      CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action        VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id   CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  before_json   JSON NULL,
  after_json    JSON NULL,
  ip            VARBINARY(16) NULL,
  user_agent    VARCHAR(512) NULL,
  trace_id      VARCHAR(64) NULL,
  request_id    VARCHAR(64) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, created_at),
  KEY idx_audit_resource (resource_type, resource_id, created_at),
  KEY idx_audit_actor (actor_type, actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS (created_at) (
  PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);
```

分区维护由 Temporal `MaintenanceWorkflow` 每月创建下月分区、删除过期分区；不使用 MySQL EVENT。`pmax` 必须保留，避免插入失败。

### 5.7 定时任务与数据权限

```sql
CREATE TABLE schedules (
  id                  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key`                VARCHAR(64) NOT NULL,
  name                VARCHAR(128) NOT NULL,
  agent_id            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_account_id  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  org_unit_id         CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  cron                VARCHAR(128) NOT NULL,
  timezone            VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  input_json          JSON NULL,
  version_policy      VARCHAR(24) NOT NULL DEFAULT 'latest_published',
  agent_version_id    CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  concurrency_policy  VARCHAR(24) NOT NULL DEFAULT 'skip',
  max_cost_usd        DECIMAL(12,6) NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'disabled',
  next_run_at         DATETIME(3) NULL,
  last_run_id         CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  failure_count       INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code     VARCHAR(16) NULL,
  revision            INT UNSIGNED NOT NULL DEFAULT 1,
  created_by          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_schedules_key (`key`),
  KEY idx_schedules_due (status, next_run_at),
  KEY idx_schedules_agent (agent_id),
  KEY idx_schedules_org (org_unit_id),
  CONSTRAINT fk_schedules_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT,
  CONSTRAINT fk_schedules_service_account FOREIGN KEY (service_account_id) REFERENCES service_accounts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE data_scopes (
  id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key`        VARCHAR(64) NOT NULL,
  name        VARCHAR(128) NOT NULL,
  type        VARCHAR(24) NOT NULL,
  config_json JSON NULL,
  description VARCHAR(512) NOT NULL DEFAULT '',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_data_scopes_key (`key`),
  KEY idx_data_scopes_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE data_policies (
  id            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role_id       CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  actions_json  JSON NOT NULL,
  scope_id      CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  effect        VARCHAR(8) NOT NULL DEFAULT 'allow',
  priority      INT NOT NULL DEFAULT 100,
  revision      INT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_data_policies (role_id, resource_type, scope_id, effect),
  KEY idx_data_policies_role (role_id, resource_type),
  CONSTRAINT fk_data_policies_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_data_policies_scope FOREIGN KEY (scope_id) REFERENCES data_scopes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

## 6. 索引与查询规则

1. 列表默认按 `created_at DESC, id DESC`；分页使用 `(created_at, id)` 游标，禁止大 OFFSET。
2. `runs` 的高频查询：状态+时间、Agent+时间、应用+时间、主体+时间、组织+时间、定时触发；均已建索引。
3. JSON 字段只在确有筛选需求时建生成列，例如：
   ```sql
   ALTER TABLE runs
     ADD COLUMN model_key VARCHAR(128)
       GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.modelKey'))) STORED,
     ADD INDEX idx_runs_model (model_key);
   ```
   不在 JSON 上做全表 `JSON_EXTRACT` 过滤。
4. URL 等长文本不建全列索引；需要唯一时存 `url_hash BINARY(32)` 并建唯一索引。
5. 组合索引遵循最左前缀；避免重复索引。
6. 大字段（Prompt、消息内容、结果）用 `MEDIUMTEXT/JSON`，但单行不超过 1 MB；超大内容进对象存储。
7. 不使用 `SELECT *` 读取消息/结果列表；列表查询只取摘要字段。
8. 所有查询必须带作用域条件（org/app/subject），防止越权。

## 7. 分区与保留

| 表 | 策略 | 默认保留 | 清理方式 |
| --- | --- | --- | --- |
| `audit_logs` | 月分区 | 365 天 | DROP PARTITION |
| `api_request_logs` | 月分区 | 90 天 | DROP PARTITION |
| `llm_usage_events` | 月分区 | 400 天 | DROP PARTITION；先聚合到 `usage_daily` |
| `run_events` | 不分区（P0） | 180 天 | 批量 DELETE + 归档 |
| `messages` / `runs` / `run_steps` / `tool_calls` | 不分区（P0） | 180 天 | 批量 DELETE，按 run 级联清理 |
| `webhook_deliveries` | 不分区 | 30 天 | 批量 DELETE |
| `mcp_health_checks` / `llm_health_checks` | 不分区 | 30 天 | 批量 DELETE |
| `notifications` | 不分区 | 90 天 | 批量 DELETE |
| `idempotency_keys` | 不分区 | 24 小时 | 定时 DELETE |
| `outbox_events` | 不分区 | 完成 7 天 | 定时 DELETE |
| `files` | 不分区 | 未引用 7 天 | 清理任务 + 对象存储生命周期 |
| `artifacts` | 不分区 | 随 Run | 随 Run 清理 |

- 保留期可在 `settings` 调整；合规要求更高时只增不减。
- 删除 Run 时按依赖顺序删除：artifacts → tool_calls → approvals → run_steps → messages（按 run）→ run_events → snapshots → runs。
- 清理必须分批（每批 1000 行）、可重入、记录审计；不在业务高峰执行。
- 日聚合 `usage_daily` 永久保留（可归档），用于账单与容量分析。

## 8. 事务与一致性

### 8.1 创建 Run

一个事务内：
1. 插入/复用 `threads`（分配消息序号）。
2. 插入 `runs`（`queued`，含 `org_unit_id` 与主体快照）。
   - 用户触发：取用户主组织；API App：取应用归属组织；服务账号：取服务账号绑定组织；定时任务：取 Schedule 的 `org_unit_id`。
   - 组织快照用于数据权限过滤，后续组织移动不改变历史 Run 的归属。
3. 插入 `run_policy_snapshots`。
4. 插入 `outbox_events`（`run.start`）。
提交后由 Outbox Dispatcher 启动 Temporal 工作流（幂等 WorkflowId = `run-{runId}`）；启动失败重试，不产生“库里有 Run 但工作流未启动”的永久不一致。

### 8.2 工具执行

- 外部调用前插入/更新 `tool_calls`（`running`），提交后再发请求。
- 外部请求不在数据库事务中；结果返回后写结果摘要与审计。
- 幂等键 `(run_id, idempotency_key)` 唯一；重复插入返回已有记录。
- 大结果先写对象存储，再更新 `result_storage_key`；失败保留错误，不写半截 JSON。
- 审计与业务状态在同一事务，确保“有变更必有审计”。

### 8.3 审批

```sql
UPDATE approvals
SET status='approved', decided_by=?, decided_at=UTC_TIMESTAMP(3),
    decision_comment=?, revision=revision+1
WHERE id=? AND status='pending' AND revision=?;
```
影响行数 0 → 冲突/已处理。随后插入 Outbox 事件通知工作流。

### 8.4 安装与升级

- 包、版本、安装历史、资源映射在同一事务写；外部连通性检查在事务外。
- 激活时用 `SELECT ... FOR UPDATE` 锁定安装行，切换 `active_version_id`，递增 registry epoch（Redis）在提交后执行。
- 失败补偿删除本次安装版本与资源映射，保留失败记录。

### 8.5 用量与成本

- 每次模型调用写 `llm_usage_events`；同一事务更新 `runs.usage_json` 和 `usage_daily` 的累计值（按日/应用/组织/模型）。
- 成本以 `DECIMAL(12,6)` 存储；未知价格记 0 并写告警标记。
- 预算检查以 `runs.cost_usd` 与 `usage_daily` 为准；Redis 只做快速预检。

### 8.6 定时任务

- `schedules` 是配置与状态来源；Temporal Schedule 是执行器。启用/修改时先写库，再 upsert Temporal Schedule，成功后更新 `next_run_at`；失败则回写 `last_error_code` 并保持停用。
- 触发时创建 Run（`trigger_type=schedule`、`trigger_ref=scheduleId`）与策略快照，运行身份为 `service_account_id`。
- 并发策略 `skip`：触发时检查该 schedule 是否有 `queued/running/waiting_approval` 的 Run，有则跳过并记录事件，不创建新 Run。
- 服务账号停用、Agent 停用、权限不足：将 `status` 置为 `disabled` 并记录原因；不删除历史。
- 修改 Cron/时区后以 Temporal 返回的下次运行时间为准，避免应用与 Temporal 不一致。

## 9. 迁移

- 工具：Drizzle Kit 生成 SQL；`packages/store/migrations/` 只追加，不修改历史文件。
- 生产只执行 `pnpm db:migrate`（迁移 Job），禁止 `drizzle-kit push`。
- 迁移使用 MySQL advisory lock：`GET_LOCK('forge:migrate', 60)`，防止多实例并发。
- 每个迁移必须：从空库可执行、可重复部署（幂等）、有回滚说明（不一定是 down SQL）。
- **expand/contract**：
  1. 新增可空列/新表 → 部署兼容代码；
  2. 双写/回填（独立 Job，分批）；
  3. 切换读取；
  4. 下一版本再删旧列/旧表。
- 禁止在同一发布中“删列 + 改代码”；大表加索引使用 `ALGORITHM=INPLACE, LOCK=NONE` 并评估。
- 迁移完成后更新 `settings.schema_version` 与 `GET /admin/v1/version`。
- 种子数据（权限码、内置角色）用幂等脚本，不用迁移硬编码 ID。

## 10. 备份、恢复与容灾

| 项 | 方案 |
| --- | --- |
| 全量备份 | 每日一次，xtrabackup 或 mydumper；保留 14 天 |
| 增量 | binlog 每 15 分钟归档到对象存储；保留 7 天 |
| 对象存储 | 版本控制 + 跨区域/异地副本（按客户） |
| Temporal | 同实例独立库，随全量备份 |
| 加密 | 备份加密；主密钥单独托管，不能与备份同处 |
| 恢复演练 | 每月一次，恢复到隔离环境并跑冒烟 |
| RPO/RTO | 默认 RPO ≤ 24h（开 binlog 可到 15min），RTO ≤ 4h |

恢复顺序：MySQL 全量 → binlog 至目标时间 → 对象存储 → 校验 schema_version → 启动 Temporal → 启动 API/Worker → 冒烟（登录、模型测试、创建 Run、审批、Webhook）。

> 主密钥丢失将导致所有凭据不可解密。主密钥必须由客户 KMS/密码管理器托管，备份与恢复手册单独交付。

## 11. 容量与参数（50 人规模基线）

| 组件 | 建议 |
| --- | --- |
| MySQL | 8 vCPU / 16 GB / 200 GB SSD；`innodb_buffer_pool_size` 约 10–11 GB |
| 连接池 | API 每实例 20；Worker 每进程 10；`max_connections` 300，预留运维 |
| Redis | 2 GB，AOF everysec；SSE Stream 上限按 Run 设置 |
| 对象存储 | 初始 500 GB，按文件增长 |
| 预估 | 200 Run/天 ≈ 7.3 万/年；消息与事件为主要增长；日志表按月分区 |

监控慢查询（`long_query_time=0.2`）、锁等待、复制延迟、磁盘、连接数；每月 Review 索引与表增长。

## 12. 安全

- 数据库不存 API Key/Provider Key 明文；只存密文与哈希。
- SSO Client Secret、Connector Client Secret 只存在 Secret/环境变量；配置缓存文件权限 `0600`，不写入数据库。
- 消息、工具参数、审计前后值中的敏感字段（Authorization、token、password、Cookie）在写入前脱敏。
- 数据权限过滤必须在 Repository 层完成；审计记录拒绝事件时不写完整敏感内容。
- PII 字段按客户合规要求配置保留期；删除用户时保留审计中的 actor ID，不保留明文邮箱。
- 开启 TLS；限制来源网段；备份加密；最小权限账户。
- 审计表禁止应用账户 UPDATE/DELETE（数据库权限层限制），清理由迁移/维护账户执行。
- 所有表默认 `utf8mb4`，避免 emoji/多语言截断。

## 13. 验收清单

- [ ] 空库执行全部迁移成功；重复执行幂等。
- [ ] 核心表 DDL、索引、外键、CHECK 与本文一致。
- [ ] 创建 Run 的事务 + Outbox 能在 10 次并发下不产生孤儿 Run。
- [ ] 审批并发决定只有一个成功，其余返回冲突。
- [ ] 工具幂等键重复执行不产生重复外部副作用。
- [ ] 数据权限查询走 `org_unit_id/subject_id/app_id` 索引；跨组织猜 ID 无法读取。
- [ ] 定时任务启用/停用与 Temporal Schedule 一致；并发 skip 不产生堆积。
- [ ] SSO/Connector 凭据只以密文/Secret 形式存在；缓存不入库、不落日志。
- [ ] 分区表跨月自动创建；过期分区可安全 DROP。
- [ ] 备份恢复演练通过，主密钥可正确解密凭据。
- [ ] 关键查询走索引，无全表扫描；慢查询有监控。
