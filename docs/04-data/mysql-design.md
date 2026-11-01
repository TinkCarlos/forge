# Forge MySQL 数据设计

## 2026-11-01 Job/消息增量字典入口（设计定稿，未实施）

完整字段、类型/NULL/默认/索引/FK、事务及迁移规格统一维护在[Job与消息数据库设计v1.0](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-数据库设计文档.md)，本节为正式数据目录。它细化本文件旧V2目标，不代表目标环境已存在；实际已实现结构仍见实现状态与Drizzle/迁移。以后更新同一字段只改该增量字典，避免两份DDL漂移。

| 数据域 | 新增或沿用目标实体 | 归属与索引重点 |
| --- | --- | --- |
| Job配置 | job_definitions/job_definition_versions/job_app_grants | 定义/不可变发布版/App显式授权；组织/创建人/引用；配置revision |
| Job执行 | job_executions/job_steps/job_step_attempts/job_resource_locks/job_events | 业务键跨入口唯一、generation/fence/attempt、组织主体SQL过滤、账号/站点单写者、事件序号 |
| 人工/来源/质量 | human_tasks/source_snapshots/quality_checks | 经执行归属鉴权；输入/业务版本、证据、待办截止与不可变检查 |
| 消息配置 | message_channels/message_channel_versions/message_rules/message_templates/message_template_versions | 统一Webhook/群配置；URL不可变Secret快照、签名当前Secret、精确legacy App消费者 |
| 消息账本 | message_deliveries/message_delivery_attempts/outbox_events | 稳定事件/渠道唯一、冻结请求体字节、尝试追加、类型专属未知/重试、组织范围 |
| 复用交付/评测/配额 | files/artifacts/eval_datasets/eval_cases/eval_runs/eval_results/quota_reservations/api_quotas；新增quota_usage_counters | 沿用同名目标；api_quotas仍是App限额配置，计数和原子预占由counter/ reservation承担，不混淆配置与用量 |

扩展schedules、runs、api_apps、webhook_deliveries与Secret消费者；不建立未实施的webhook_endpoints目标表。先expand再受控回填、停止旧派发后切换；当前未分配新迁移编号、未生成SQL/Drizzle产物或执行DDL。详情参见配套开发/接口设计的切换与兼容边界。

版本：1.0　日期：2026-10-21　状态：待评审

> **MySQL 8.0.30+ 是 Forge 唯一系统数据库。** 不提供 SQLite/PostgreSQL 运行模式；开发、测试、生产统一使用 MySQL。Redis 与对象存储不是事实来源。

## 0. 当前E1落地边界（2026-10-31）

当前Repository仍使用mysql2；`packages/store/src/schema/index.ts`以独立001–008空库建立001–008的34张表Drizzle基线。`packages/store/drizzle/0000_legacy_baseline.sql`只作差分参考，不交给应用重复执行；生成的`0001_configuration_revision.sql`经审查映射唯一`schema_migrations`版本`009_configuration_revision`。后续继续`pnpm db:generate`生成、人工审查、接入`pnpm db:migrate`，不启用第二套Drizzle迁移历史或push。

009只给agents、skills、mcp_servers、mcp_tools、tool_sources、tools、llm_providers、llm_models、llm_routes、api_apps、users、service_accounts、schedules、oidc_role_mappings、plugins、org_units、data_policies、settings新增`revision INT UNSIGNED NOT NULL DEFAULT 1`，不改既有类型、索引与约束。所有列成功才写历史；缺列逐项补，部分DDL中断可重跑，遇到既有不兼容revision列拒绝标记成功。迁移执行器持数据库名隔离的MySQL命名锁，防并行执行。

配置CAS在行锁内读取当前版本，再`UPDATE ... WHERE id=? AND revision=?`递增，审计同事务；settings按key定位。Agent/Skill子版本及父指针同事务，失败不遗留新版本。运行时钟不增版本，自动停用/SSO同步/seed配置更新使旧版本失效。现有无CRUD的组织、策略、工具/路由等仅补Schema，并未因此交付完整管理能力。

真实MySQL检查列类型、空值、默认值、字符集、排序规则、on-update、外键和索引；CURRENT_TIMESTAMP/now同义函数及tinyint显示宽度按等价规范化。导入时补齐了Drizzle未保留的ASCII二进制列和DATETIME ON UPDATE，避免未来差分改坏现有Schema。下面的V2目标表字典仍包含未实现资源，以实现状态为准。

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
           ├─< api_apps ─< api_keys / api_quotas / message_channels（2026-11-01目标）
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
| `resource_references` | 资源引用/卸载保护 | `id`, `from_type`, `from_id`, `from_version_id`, `to_type`, `to_id`, `to_key`, `to_version`, `binding_key`, `created_at` | `uk_resource_reference_binding(from_type,from_id,binding_key)`; `idx_resource_refs_to(to_type,to_id)`; `idx_resource_refs_from(from_type,from_id)` |

`plugin_installations.scope_type` 为 `global`/`org`/`role`（Secret作用域另见4.7.1）。`active_version_id` 指向 `plugin_installation_versions.id`；升级/回滚原子切换。`resource_references` 同时服务 Skill/MCP/工具/Provider/Secret 的引用检查。

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

`messages.content_json` 为内容块数组（text/tool_call/tool_result/image_ref），大结果存对象存储。实际兼容字段 `seq` 保持 Run 内序号；016新增 `thread_seq BIGINT UNSIGNED NULL`，新消息事务锁会话并递增 `threads.next_message_seq BIGINT UNSIGNED NOT NULL DEFAULT 1`，唯一 `(thread_id,thread_seq)`。历史消息保留 NULL，不编造严格顺序；读取按旧消息原时间/Run/seq稳定排序后追加新序号消息。`protocol_version VARCHAR(32) NULL` 标明新写入的协议，旧正文保持原值。`run_events.seq` 按 Run 递增。

**016运行/会话兼容扩展**（仅任务库本地实施，生产未执行）：`runs.runtime_engine VARCHAR(24) NOT NULL DEFAULT 'mysql-legacy'`、`snapshot_quality VARCHAR(16) NOT NULL DEFAULT 'legacy'`、`retry_of_run_id/workspace_id CHAR(26) NULL`、`workflow_id VARCHAR(128) NULL UNIQUE`；旧运行不改引擎、不伪造 frozen。`threads.app_id/active_run_id CHAR(26) NULL`、`revision INT UNSIGNED NOT NULL DEFAULT 1`、`deleted_at DATETIME(3) NULL`；新建会话显式写 App 归属；旧App会话仅在锁内核实主体为该App、至少存在一个历史Run且所有Run的App/主体/Agent均一致后绑定，不一致或缺证据返回404。活动受理锁会话，拒绝已有非终态 Run；终态仅清除指向自己的 active_run_id。旧 worker 的普通与指定ID领取均只接受 mysql-legacy；快照/Pi/Temporal尚未接通时不写其它引擎。

索引新增 `idx_runs_engine_status(runtime_engine,status,created_at,id)`、`idx_runs_thread_status(thread_id,status,created_at,id)`、`uk_runs_workflow(workflow_id)`、`uk_messages_thread_seq(thread_id,thread_seq)`、`idx_threads_app_created(app_id,created_at,id)`。活跃指针不加循环外键，受理时验证；历史 Run 不自动选取活跃指针。016仅expand，断点重跑检查完整元数据，不做down；回兼容版保留新列。生产先备份及人工审批。

**过渡调度列（Temporal 之前）**：`claimed_by`、`lease_expires_at`、`heartbeat_at` 只用于 MySQL 队列认领与崩溃续跑，不是业务事实来源。Worker 认领 `queued`，或租约已过期的 `running`；进入 `waiting_approval` 或 Run 结束后清空租约。接上 Temporal 后这三列停止写入，不在同一版本删除。`claimed_by` 的值为 `hostname:pid:epoch`（epoch 为进程启动时生成一次的 8 位 hex，总长不超过 128，超长时先截 hostname）：重启后复用同一 host 和 pid 的进程（如容器里的 pid 1）不会被当成原持有者；旧格式 `hostname:pid` 的行只按字符串比较，租约过期或为空时照常可认领，无需迁移。

**0.1.x `run_steps`**：类型为 `prepare_context` / `compress` / `call_model` / `execute_tool` / `validate_output`。模型标识写入 `summary_json.modelKey`；目标字典中的 `model_id` 等外键留待模型目录接通后再填。`tool_calls.idempotency_key` 新记录存 `<runId>:s<model_step>:<step_index>`（r5，模型步骤序号与步内序号），与 `attempt` 一起用于崩溃后续跑时不重复插入已成功的调用；同键已存在但 `tool_key` 不同时报 `SYS-9001`。1.3 之前的旧记录不回填。

**r5 迁移 008（只加列，全部 `ALGORITHM=INSTANT`，不加索引）**：`tools.read_only`、`mcp_tools.read_only`、`tool_calls.read_only`（`TINYINT(1)`，默认 0 = 有副作用；只有 `tools` 在新加列时按 HTTP 方法回填 GET/HEAD 为 1）；`approvals.reason`（`VARCHAR(16)`，默认 `policy`，接手产生的审批为 `interrupted`）；`tool_calls.call_id`（供应商调用 id，仅存档）、`model_step`、`step_index`（可空，不回填）。

**0.1.x 幂等与 Webhook**：`idempotency_keys.scope` 对Run创建使用API App id；API Key轮换使用 `apikey.rotate:{旧KeyID}`，保留24小时。轮换记录只存新/旧Key元数据，不存明文；旧Key行锁串行同Key轮换/吊销，密钥变更、幂等记录和审计同事务。当前实际列名为 `idempotency_key`，不需要新增迁移。`webhook_deliveries.app_id` 指向应用上的单个 Webhook URL；目标设计里的 `webhook_endpoints` 尚未拆出，因此没有 `endpoint_id`。投递状态为 `pending` / `delivered` / `failed`。

### 4.6 开放平台与用量

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `api_apps` | 调用应用 | `id`, `key`, `name`, `description`, `owner_org_unit_id`, `status`, `scopes_json`, `revision`, `created_by` | `uk_api_apps_key`; `idx_api_apps_org` |
| `api_keys` | 密钥 | `id`, `app_id`, `name`, `prefix`, `key_hash BINARY(32)`, `scopes_json`, `status`, `expires_at`, `last_used_at`, `revoked_at` | `uk_api_keys_prefix`; `idx_api_keys_app` |
| `api_quotas` | 应用配额 | `app_id`, `rpm`, `concurrent_runs`, `daily_runs`, `monthly_runs`, `monthly_cost_usd`, `updated_at` | PK(`app_id`) |
| `message_channels` / `message_channel_versions` | 统一消息渠道（设计增量，未建表），替代原未实现的webhook_endpoints目标 | 配置归属、URL Secret快照、签名引用、渠道版本与legacy App消费者 | 详见本章末Job/消息增量及其唯一字段字典 |
| `webhook_deliveries` | 现有单App回调历史及过渡兼容镜像 | 当前字段仍为app_id/event_id/payload_json等；新增message_delivery_id后由统一消息服务维护，不再单独派发 | 当前uk(app_id,event_id)保留；统一message_deliveries/attempts见增量设计 |
| `api_request_logs` | 开放 API 访问日志 | `id`, `app_id`, `key_id`, `method`, `path`, `status_code`, `latency_ms`, `run_id`, `ip`, `user_agent`, `error_code`, `created_at` | PK(`id`,`created_at`)；按月分区；`idx_api_logs_app` |
| `usage_daily` | 用量聚合 | `date`, `scope_type`, `scope_id`, `runs`, `input_tokens`, `output_tokens`, `cost_usd`, `errors` | PK(`date`,`scope_type`,`scope_id`) |

`key_hash` 使用服务端 pepper 的 HMAC-SHA256；`prefix` 用于定位 Key（前 12–16 字符）。API Key 明文不落库。当前MVP实际存储 `key_hash CHAR(64)`，`status=active|revoked`，没有 `revoked_at`；吊销时间从审计读取。创建可设置未来 `expires_at`，轮换继承旧Key的Scope及有效期，重叠只缩短旧Key有效期；到期在鉴权时实时判定，无需改写状态。生命周期接口见[管理API第18节](../03-api/admin-api.md#18-api-key-生命周期2026-10-31-已实现增量fr-op-02)。

### 4.7 治理、审计与通知

| 表 | 用途 | 关键字段 | 索引/约束 |
| --- | --- | --- | --- |
| `governance_policies` | 风险/审批/预算策略 | `id`, `key`, `name`, `type`, `rules_json`, `priority`, `status` | `uk_governance_policies_key`; `idx_policies_type` |
| `data_scopes` | 数据范围定义 | `id`, `key`, `name`, `type`, `config_json`, `description` | `uk_data_scopes_key`; `idx_data_scopes_type` |
| `data_scope_orgs` | 自定义组织范围 | `data_scope_id`, `org_unit_id` | PK(`data_scope_id`,`org_unit_id`) |
| `data_policies` | 角色数据策略 | `id`, `role_id`, `resource_type`, `actions_json`, `scope_id`, `effect`, `priority`, `revision` | `uk_data_policies(role,resource,scope,effect)`; `idx_data_policies_role` |
| `principal_data_grants` | 例外授权/拒绝 | `id`, `principal_type`, `principal_id`, `resource_type`, `actions_json`, `scope_id`, `effect`, `expires_at` | `idx_principal_grants_principal` |
| `resource_grants` | 单条资源共享（P1） | `id`, `resource_type`, `resource_id`, `principal_type`, `principal_id`, `actions_json`, `expires_at` | `uk_resource_grants`; `idx_resource_grants_resource` |
| `secrets` | 凭据主记录 | `id`, `key`, `name`, `scope_type`, `scope_id`, `active_version_id`, `status` | `uk_secrets_scope(scope_type,scope_resource_type,scope_id,key)` |
| `secret_versions` | 凭据密文版本 | `id`, `secret_id`, `version`, `ciphertext MEDIUMBLOB`, `nonce`, `tag`, `encrypted_dek`, `dek_nonce`, `dek_tag`, `key_version`, `created_by`, `created_at` | `uk_secret_versions(secret_id,version)` |
| `audit_logs` | 审计 | `id`, `actor_type`, `actor_id`, `action`, `resource_type`, `resource_id`, `before_json`, `after_json`, `ip`, `user_agent`, `trace_id`, `request_id`, `created_at` | PK(`id`,`created_at`)；按月分区；`idx_audit_resource`; `idx_audit_actor` |
| `settings` | 系统设置 | `scope_type`, `scope_id`, `key`, `value_json`, `updated_by`, `updated_at` | PK(`scope_type`,`scope_id`,`key`) |
| `notifications` | 站内通知 | `id`, `user_id`, `type`, `title`, `body`, `resource_type`, `resource_id`, `read_at`, `created_at` | `idx_notifications_user(user_id,read_at)` |
| `outbox_events` | 可靠事件派发 | `id`, `topic`, `payload_json`, `status`, `attempts`, `available_at`, `created_at`, `processed_at` | `idx_outbox_due(status,available_at)` |

`audit_logs` 只追加；应用不提供更新/删除 API。合规删除通过分区 DROP 或归档流程完成。

### 4.7.1 E1 凭据库实际数据字典（010）

当前共37张表；`0002_secret_vault.sql`由唯一迁移器映射`010_secret_vault`。009的18表清单固定，不随新表变化。010只增表/列；旧列保留供兼容读取，业务回填由独立`secrets:migrate`执行，不与结构迁移混做。

| 表 | 已实现字段与约束 |
| --- | --- |
| `secrets` | `id CHAR(26) ascii_bin` PK；`key VARCHAR(64)`、`name(128)`、`description(1024)`；`scope_type(32)`=`platform/org/resource`，`scope_id CHAR(26) ascii_bin NOT NULL DEFAULT ''`，`scope_resource_type(32) NOT NULL DEFAULT ''`；`owner_org_unit_id/created_by/active_version_id CHAR(26) ascii_bin NULL`；`status(16)`=`active/disabled/deleted`，`revision INT UNSIGNED DEFAULT 1`，UTC毫秒创建/更新/删除时间。唯一`(scope_type,scope_resource_type,scope_id,key)`避免NULL唯一键漏洞；索引`(owner_org_unit_id,status,id)`、`(created_by,status,id)` |
| `secret_versions` | `id` PK、`secret_id` FK RESTRICT；`version INT UNSIGNED`，唯一`(secret_id,version)`；`ciphertext MEDIUMBLOB`、`nonce VARBINARY(12)`、`tag VARBINARY(16)`；`encrypted_dek VARBINARY(32)`、`dek_nonce(12)`、`dek_tag(16)`、`key_version VARCHAR(64)`；创建人/时间；索引`(key_version,id)`。每版本独立DEK，AAD绑定Secret ID、版本和不可变作用域；仅DEK包装允许运维重包裹 |
| `resource_references` | 通用引用字段加`binding_key VARCHAR(255) NOT NULL`，唯一`(from_type,from_id,binding_key)`；索引`(to_type,to_id)`及`(from_type,from_id)`。当前只实现Secret目标及`api-key/webhook/header:<lowercase>`槽位，其他依赖引用仍属后续阶段 |
| `llm_providers` | 增`secret_id CHAR(26) ascii_bin NULL`及`header_secret_refs_json JSON NULL`；原`api_key_encrypted/headers_json`兼容保留 |
| `mcp_servers/tool_sources` | 增`header_secret_refs_json JSON NULL`；非空字面Header新写全部转资源作用域Secret，空Header值可保留字面空串 |
| `api_apps` | 增`webhook_secret_id CHAR(26) ascii_bin NULL`；原`webhook_secret_encrypted`兼容保留 |

`platform`的scope_id与scope_resource_type存空串，接口scope为`{type:"platform"}`；org仅精确组织，resource仅精确类型/ID。元数据SQL按owner_org/created_by过滤，运行不返回密文和DEK。父资源CAS、Secret创建/引用与审计同事务；绑定/删除以同一Secret行锁防竞态，替换引用只按已存在主键删除以避免空范围间隙锁。软删除保留所有版本/审计；被引用不能删除；运维迁移也覆盖已软删MCP历史但不恢复其运行可见性。运维边界及旧密钥退役见[凭据维护](../06-operations/secrets.md)。

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

## 账号生命周期增量（011）

users保留删除行，status=deleted并释放登录标识，历史主体ID不变；idp_subject/idp_issuer采用utf8mb4_0900_bin，旧issuer为空需管理员明确绑定。新增auth_login_limits仅存HMAC摘要、计数和UTC窗口；audit_logs新增actor_name快照、outcome和检索索引。Drizzle 0003对应迁移011；未部署。详细字段、事务和保留见[开发设计](../../.talking-us/2026-11-01-forge-identity-design.md)。

## 012 全局角色与功能权限

Drizzle `0004_roles.sql` 对应唯一迁移 `012_roles`，新增4表，当前Schema共42表。roles：id CHAR(26) ascii_bin、key VARCHAR(32)唯一且不可变、name128、description1024、builtin TINYINT、status active/disabled/deleted、revision UINT、UTC created/updated DATETIME(3)。permissions：key64主键、domain32、kind16、description128；仅代码当前支持的权限目录与内部平台通配符。role_permissions：role_id+permission_key复合主键，restrict外键到roles/permissions。role_bindings：id、role_id restrict外键、principal_type24、principal_id ASCII ID、scope_type16、scope_id ASCII VARCHAR(26)非NULL默认空串、created_at；唯一(role,principal,scope_type,scope_id)，主体检索索引(principal_type,principal_id)。本增量仅接受global+空scope_id，不用NULL破坏唯一性。

所有新表显式InnoDB/utf8mb4_0900_ai_ci；DDL恢复及列/默认值/索引/外键校验完成后再标记迁移。角色默认模板按首次插入初始化，已有空权限/停用/自定义配置不覆盖；目录元数据可刷新。users.role/service_accounts.role仍是主角色Key，不删旧字段或改现有数据归属。删除账号清除其附加绑定，历史账号ID及操作日志保留；角色删除仅在无有效账号、服务账号、绑定、映射、策略引用后标deleted，保留代码与历史。授权变化与成功审计同事务。

SQL相关子查询在同一次身份/列表查询生成角色、有效权限与全部配置权限快照；不使用GROUP_CONCAT、不逐用户补查、不在列表全量读取后过滤。既有实际数据范围尚未替换为完整策略模型。详细字段/生命周期和验收见[U03设计](../../.talking-us/2026-11-01-forge-roles-design.md)。


## 013/014 Job基础开发批次（仅隔离库已执行）

013_job_message_permissions只同步新增Job、消息、人工及评测功能目录，沿用现有initializeRoles逻辑，保留已维护的角色矩阵，不给旧非管理员角色追加权限。

014_job_core_expand对应Drizzle `0005_job_core_expand.sql`，新增job_definitions、job_definition_versions、job_app_grants、job_executions、job_steps、job_step_attempts、job_events、outbox_events。完整字段/约束以[本增量字典](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-数据库设计文档.md)第3节、4.2节为准；实际DDL与Drizzle同步，显式InnoDB/utf8mb4及标识二进制排序、COMMENT、状态CHECK、RESTRICT外键。迁移以冻结的job-core-shape.json检查列/默认值/索引/FK/CHECK/字符集，不接受同名错误结构；断点后可继续，DDL自动提交不宣称事务回滚。

受理事务使用READ COMMITTED，Job父行锁串行化同业务受理/发布，执行/初始根步骤/首事件/outbox/审计/HTTP幂等响应在同一连接提交；仅派生初始根节点，后续map/循环按需展开仍待运行时接入。业务去重不随HTTP缓存过期消失。列表/详情要求QueryFilter，在SQL中组合allow、deny和外部上限，NULL匹配按FALSE；查询游标签名并绑定筛选与范围。完整E1策略求值与外部身份装配尚未接入，不能把过滤编译器当成完整权限系统。

真实MySQL8.4技术验证已覆盖断点/重跑/空库与升级同形、错误CHECK/默认值/索引拒绝、受理并发/去重/回滚/队列上限。MySQL8.0.30版本兼容、EXPLAIN代表规模、生产迁移、旧计划/App/投递回填及消息实体均待实施/验证；本批不切换现有worker或旧Webhook发送链，不产生真实外部副作用。回退保留新增Schema，不向原MVP代码开放Job记录；后续正式切换仍须兼容版及只读窗口。
