CREATE TABLE `agent_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`agent_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'draft',
	`instructions` mediumtext NOT NULL,
	`spec_json` json NOT NULL,
	`changelog` varchar(2048) NOT NULL DEFAULT '',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`published_at` datetime(3),
	CONSTRAINT `agent_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_agent_versions` UNIQUE(`agent_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`latest_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`published_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`api_enabled` tinyint NOT NULL DEFAULT 0,
	`api_scopes_json` json,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_agents_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `api_apps` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`scopes_json` json NOT NULL,
	`webhook_url` varchar(2048),
	`webhook_secret_encrypted` text,
	`rate_limit_per_minute` int NOT NULL DEFAULT 60,
	`daily_quota` int NOT NULL DEFAULT 1000,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_apps_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_api_apps_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`prefix` varchar(24) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`scopes_json` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`expires_at` datetime(3),
	`last_used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_api_keys_prefix` UNIQUE(`prefix`)
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`tool_call_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`risk_level` varchar(16) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`decided_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`decided_at` datetime(3),
	`comment` varchar(1024),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`reason` varchar(16) NOT NULL DEFAULT 'policy',
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`actor_type` varchar(16) NOT NULL,
	`actor_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`action` varchar(64) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`details_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_oidc_states` (
	`state_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`verifier` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`nonce` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`return_to` varchar(2048) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_oidc_states_state_hash` PRIMARY KEY(`state_hash`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`csrf_token` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`last_seen_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `data_policies` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`role` varchar(32) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`actions_json` json NOT NULL,
	`scope_type` varchar(24) NOT NULL,
	`effect` varchar(8) NOT NULL DEFAULT 'allow',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `data_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_data_policies` UNIQUE(`role`,`resource_type`,`scope_type`,`effect`)
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`owner_type` varchar(16) NOT NULL,
	`owner_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(255) NOT NULL,
	`mime_type` varchar(128) NOT NULL,
	`size` bigint unsigned NOT NULL,
	`storage_path` varchar(1024) NOT NULL,
	`checksum` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`scope` varchar(64) NOT NULL,
	`idempotency_key` varchar(200) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`status_code` int NOT NULL DEFAULT 0,
	`response_json` json,
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `idempotency_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_idempotency_scope_key` UNIQUE(`scope`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `llm_models` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`provider_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(128) NOT NULL,
	`display_name` varchar(128) NOT NULL,
	`capabilities_json` json,
	`context_window` int NOT NULL DEFAULT 32768,
	`max_output_tokens` int NOT NULL DEFAULT 4096,
	`input_price_per_mtok` decimal(12,6) NOT NULL DEFAULT '0.000000',
	`output_price_per_mtok` decimal(12,6) NOT NULL DEFAULT '0.000000',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `llm_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_llm_models` UNIQUE(`provider_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `llm_providers` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`protocol` varchar(32) NOT NULL DEFAULT 'openai-compatible',
	`base_url` varchar(2048) NOT NULL,
	`api_key_encrypted` text,
	`headers_json` json,
	`timeout_ms` int NOT NULL DEFAULT 120000,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `llm_providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_llm_providers_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `llm_routes` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`candidates_json` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `llm_routes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_llm_routes_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`transport` varchar(16) NOT NULL DEFAULT 'http',
	`url` varchar(2048) NOT NULL,
	`headers_json` json,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`last_error` varchar(1024),
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `mcp_servers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_mcp_servers_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`server_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`input_schema_json` json,
	`risk_level` varchar(16) NOT NULL DEFAULT 'medium',
	`enabled` tinyint NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`read_only` tinyint NOT NULL DEFAULT 0,
	CONSTRAINT `mcp_tools_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_mcp_tools` UNIQUE(`server_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`thread_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`seq` int unsigned NOT NULL,
	`role` varchar(16) NOT NULL,
	`content_json` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_messages_run_seq` UNIQUE(`run_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `oidc_role_mappings` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`agent_role_code` varchar(100) NOT NULL,
	`agent_role_name` varchar(100) NOT NULL DEFAULT '',
	`local_role` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `oidc_role_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_oidc_role_mappings` UNIQUE(`agent_role_code`,`agent_role_name`)
);
--> statement-breakpoint
CREATE TABLE `org_units` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`parent_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`path` varchar(512) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_units_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_org_units_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(128) NOT NULL,
	`version` varchar(32) NOT NULL,
	`type` varchar(32) NOT NULL,
	`name` varchar(128) NOT NULL,
	`manifest_json` json NOT NULL,
	`resources_json` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `plugins_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_plugins` UNIQUE(`key`,`version`)
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`seq` int unsigned NOT NULL,
	`type` varchar(64) NOT NULL,
	`data_json` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `run_events_run_id_seq` PRIMARY KEY(`run_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`seq` int unsigned NOT NULL,
	`type` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'running',
	`tool_call_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`summary_json` json,
	`error_code` varchar(16),
	`input_tokens` int unsigned NOT NULL DEFAULT 0,
	`output_tokens` int unsigned NOT NULL DEFAULT 0,
	`cost_usd` decimal(12,6) NOT NULL DEFAULT '0.000000',
	`started_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	CONSTRAINT `run_steps_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_run_steps` UNIQUE(`run_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`thread_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`agent_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`agent_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`subject_type` varchar(16) NOT NULL,
	`subject_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'queued',
	`trigger_type` varchar(16) NOT NULL DEFAULT 'manual',
	`trigger_ref` varchar(128),
	`input_json` json NOT NULL,
	`output_json` json,
	`usage_json` json,
	`cost_usd` decimal(12,6) NOT NULL DEFAULT '0.000000',
	`error_code` varchar(16),
	`error_message` varchar(1024),
	`cancel_requested` tinyint NOT NULL DEFAULT 0,
	`claimed_by` varchar(128),
	`lease_expires_at` datetime(3),
	`heartbeat_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	CONSTRAINT `runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`agent_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`subject_type` varchar(16) NOT NULL DEFAULT 'service',
	`subject_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`service_account_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`cron` varchar(128) NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
	`input_json` json,
	`version_policy` varchar(24) NOT NULL DEFAULT 'published',
	`pinned_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`concurrency_policy` varchar(24) NOT NULL DEFAULT 'skip',
	`failure_count` int unsigned NOT NULL DEFAULT 0,
	`last_error_code` varchar(16),
	`status` varchar(16) NOT NULL DEFAULT 'disabled',
	`next_run_at` datetime(3),
	`last_run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_schedules_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `service_accounts` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`role` varchar(32) NOT NULL DEFAULT 'user',
	`data_scope` varchar(32) NOT NULL DEFAULT 'org',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `service_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_service_accounts_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(128) NOT NULL,
	`value_json` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`skill_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'draft',
	`content_md` mediumtext NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`published_at` datetime(3),
	CONSTRAINT `skill_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_skill_versions` UNIQUE(`skill_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`latest_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`published_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `skills_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_skills_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`agent_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`subject_type` varchar(16) NOT NULL,
	`subject_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`title` varchar(255) NOT NULL DEFAULT '',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `threads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`tool_key` varchar(160) NOT NULL,
	`args_json` json NOT NULL,
	`result_json` json,
	`result_text` mediumtext,
	`status` varchar(24) NOT NULL DEFAULT 'running',
	`risk_level` varchar(16) NOT NULL DEFAULT 'low',
	`approval_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`idempotency_key` varchar(191),
	`attempt` int unsigned NOT NULL DEFAULT 1,
	`error_code` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`read_only` tinyint NOT NULL DEFAULT 0,
	`call_id` varchar(191),
	`model_step` int unsigned,
	`step_index` int unsigned,
	CONSTRAINT `tool_calls_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_tool_calls_run_idem` UNIQUE(`run_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `tool_sources` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`base_url` varchar(2048) NOT NULL,
	`headers_json` json,
	`spec_json` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tool_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_tool_sources_key` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`source_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`operation_id` varchar(128) NOT NULL,
	`method` varchar(8) NOT NULL,
	`path` varchar(1024) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`input_schema_json` json,
	`risk_level` varchar(16) NOT NULL DEFAULT 'low',
	`enabled` tinyint NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`read_only` tinyint NOT NULL DEFAULT 0,
	CONSTRAINT `tools_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_tools` UNIQUE(`source_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`username` varchar(64) NOT NULL,
	`email` varchar(255) NOT NULL,
	`display_name` varchar(128) NOT NULL,
	`password_hash` varchar(255),
	`role` varchar(32) NOT NULL DEFAULT 'user',
	`data_scope` varchar(16) NOT NULL DEFAULT 'self',
	`org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`idp_subject` varchar(255),
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`is_emergency_admin` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_users_email` UNIQUE(`email`),
	CONSTRAINT `uk_users_idp_subject` UNIQUE(`idp_subject`),
	CONSTRAINT `uk_users_username` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`payload_json` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3) NOT NULL,
	`response_status` int,
	`error_message` varchar(512),
	`error_code` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`delivered_at` datetime(3),
	CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_webhook_delivery_event` UNIQUE(`app_id`,`event_id`)
);
--> statement-breakpoint
ALTER TABLE `agent_versions` ADD CONSTRAINT `fk_agent_versions_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `fk_api_keys_app` FOREIGN KEY (`app_id`) REFERENCES `api_apps`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `fk_approvals_run` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `fk_auth_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llm_models` ADD CONSTRAINT `fk_llm_models_provider` FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mcp_tools` ADD CONSTRAINT `fk_mcp_tools_server` FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `fk_messages_run` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `fk_messages_thread` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_events` ADD CONSTRAINT `fk_run_events_run` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_steps` ADD CONSTRAINT `fk_run_steps_run` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `fk_runs_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `fk_runs_agent_version` FOREIGN KEY (`agent_version_id`) REFERENCES `agent_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `fk_runs_thread` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `schedules` ADD CONSTRAINT `fk_schedules_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `skill_versions` ADD CONSTRAINT `fk_skill_versions_skill` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD CONSTRAINT `fk_tool_calls_run` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tools` ADD CONSTRAINT `fk_tools_source` FOREIGN KEY (`source_id`) REFERENCES `tool_sources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `fk_webhook_deliveries_app` FOREIGN KEY (`app_id`) REFERENCES `api_apps`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_agent_versions_status` ON `agent_versions` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agents_api` ON `agents` (`api_enabled`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agents_org` ON `agents` (`owner_org_unit_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_app` ON `api_keys` (`app_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approvals_run` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_status` ON `approvals` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_logs` (`actor_type`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_org` ON `audit_logs` (`org_unit_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource` ON `audit_logs` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_oidc_states_expires` ON `auth_oidc_states` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expires` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_files_owner` ON `files` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_idempotency_expires` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_org_units_path` ON `org_units` (`path`);--> statement-breakpoint
CREATE INDEX `idx_run_events_created` ON `run_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_steps_type` ON `run_steps` (`run_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_runs_agent_created` ON `runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_app_created` ON `runs` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_lease` ON `runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_org` ON `runs` (`org_unit_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_status_created` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_subject` ON `runs` (`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_schedules_due` ON `schedules` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_service_accounts_status` ON `service_accounts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_threads_subject` ON `threads` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_calls_run` ON `tool_calls` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_users_org` ON `users` (`org_unit_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_delivery_due` ON `webhook_deliveries` (`status`,`next_attempt_at`);