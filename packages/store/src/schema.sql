CREATE TABLE IF NOT EXISTS org_units (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  parent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  path VARCHAR(512) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_org_units_key (`key`),
  KEY idx_org_units_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'user',
  data_scope VARCHAR(16) NOT NULL DEFAULT 'self',
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idp_subject VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  idp_issuer VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  is_emergency_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_username (username),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_idp_subject (idp_subject),
  KEY idx_users_org (org_unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS api_apps (
  webhook_secret_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  owner_org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  scopes_json JSON NOT NULL,
  webhook_url VARCHAR(2048) NULL,
  webhook_secret_encrypted TEXT NULL,
  rate_limit_per_minute INT NOT NULL DEFAULT 60,
  daily_quota INT NOT NULL DEFAULT 1000,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_api_apps_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  app_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  prefix VARCHAR(24) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  scopes_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  expires_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_api_keys_prefix (prefix),
  KEY idx_api_keys_app (app_id, status),
  CONSTRAINT fk_api_keys_app FOREIGN KEY (app_id) REFERENCES api_apps (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status_code INT NOT NULL DEFAULT 0,
  response_json JSON NULL,
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_idempotency_scope_key (scope, idempotency_key),
  KEY idx_idempotency_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  app_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  response_status INT NULL,
  error_message VARCHAR(512) NULL,
  error_code VARCHAR(16) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  UNIQUE KEY uk_webhook_delivery_event (app_id, event_id),
  KEY idx_webhook_delivery_due (status, next_attempt_at),
  CONSTRAINT fk_webhook_deliveries_app FOREIGN KEY (app_id) REFERENCES api_apps (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agents (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  owner_org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  latest_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  published_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  api_enabled TINYINT(1) NOT NULL DEFAULT 0,
  api_scopes_json JSON NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uk_agents_key (`key`),
  KEY idx_agents_org (owner_org_unit_id, status),
  KEY idx_agents_api (api_enabled, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agent_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  agent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  instructions MEDIUMTEXT NOT NULL,
  spec_json JSON NOT NULL,
  changelog VARCHAR(2048) NOT NULL DEFAULT '',
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  UNIQUE KEY uk_agent_versions (agent_id, version),
  KEY idx_agent_versions_status (agent_id, status),
  CONSTRAINT fk_agent_versions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS skills (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  latest_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  published_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uk_skills_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS skill_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  skill_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  content_md MEDIUMTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  UNIQUE KEY uk_skill_versions (skill_id, version),
  CONSTRAINT fk_skill_versions_skill FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mcp_servers (
  header_secret_refs_json JSON NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  transport VARCHAR(16) NOT NULL DEFAULT 'http',
  url VARCHAR(2048) NOT NULL,
  headers_json JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_error VARCHAR(1024) NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uk_mcp_servers_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mcp_tools (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  server_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  input_schema_json JSON NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'medium',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  read_only TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uk_mcp_tools (server_id, name),
  CONSTRAINT fk_mcp_tools_server FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tool_sources (
  header_secret_refs_json JSON NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  base_url VARCHAR(2048) NOT NULL,
  headers_json JSON NULL,
  spec_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_tool_sources_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tools (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  source_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(1024) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  input_schema_json JSON NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_only TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tools (source_id, name),
  CONSTRAINT fk_tools_source FOREIGN KEY (source_id) REFERENCES tool_sources (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS llm_providers (
  secret_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  header_secret_refs_json JSON NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  protocol VARCHAR(32) NOT NULL DEFAULT 'openai-compatible',
  base_url VARCHAR(2048) NOT NULL,
  api_key_encrypted TEXT NULL,
  headers_json JSON NULL,
  timeout_ms INT NOT NULL DEFAULT 120000,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_llm_providers_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS llm_models (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  provider_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(128) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  capabilities_json JSON NULL,
  context_window INT NOT NULL DEFAULT 32768,
  max_output_tokens INT NOT NULL DEFAULT 4096,
  input_price_per_mtok DECIMAL(12,6) NOT NULL DEFAULT 0,
  output_price_per_mtok DECIMAL(12,6) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_llm_models (provider_id, `key`),
  CONSTRAINT fk_llm_models_provider FOREIGN KEY (provider_id) REFERENCES llm_providers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS llm_routes (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  candidates_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_llm_routes_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS threads (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  agent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subject_type VARCHAR(16) NOT NULL,
  subject_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
  `active_run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
  `next_message_seq` bigint unsigned DEFAULT 1 NOT NULL,
  `revision` int unsigned DEFAULT 1 NOT NULL,
  `deleted_at` datetime(3),
  KEY `idx_threads_app_created` (`app_id`,`created_at`,`id`),
  KEY idx_threads_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS runs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  thread_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subject_type VARCHAR(16) NOT NULL,
  subject_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual',
  trigger_ref VARCHAR(128) NULL,
  input_json JSON NOT NULL,
  output_json JSON NULL,
  usage_json JSON NULL,
  cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
  error_code VARCHAR(16) NULL,
  error_message VARCHAR(1024) NULL,
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  claimed_by VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  heartbeat_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  `runtime_engine` varchar(24) DEFAULT 'mysql-legacy' NOT NULL,
  `snapshot_quality` varchar(16) DEFAULT 'legacy' NOT NULL,
  `retry_of_run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
  `workspace_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
  `workflow_id` varchar(128),
  UNIQUE KEY `uk_runs_workflow` (`workflow_id`),
  KEY `idx_runs_engine_status` (`runtime_engine`,`status`,`created_at`,`id`),
  KEY `idx_runs_thread_status` (`thread_id`,`status`,`created_at`,`id`),
  KEY idx_runs_status_created (status, created_at),
  KEY idx_runs_lease (status, lease_expires_at),
  KEY idx_runs_agent_created (agent_id, created_at),
  KEY idx_runs_app_created (app_id, created_at),
  KEY idx_runs_subject (subject_type, subject_id, created_at),
  KEY idx_runs_org (org_unit_id, created_at),
  CONSTRAINT fk_runs_thread FOREIGN KEY (thread_id) REFERENCES threads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_runs_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT,
  CONSTRAINT fk_runs_agent_version FOREIGN KEY (agent_version_id) REFERENCES agent_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  thread_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq INT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL,
  content_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `thread_seq` bigint unsigned,
  `protocol_version` varchar(32),
  UNIQUE KEY `uk_messages_thread_seq` (`thread_id`,`thread_seq`),
  UNIQUE KEY uk_messages_run_seq (run_id, seq),
  KEY idx_messages_thread (thread_id, seq),
  CONSTRAINT fk_messages_thread FOREIGN KEY (thread_id) REFERENCES threads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_messages_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tool_calls (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tool_key VARCHAR(160) NOT NULL,
  args_json JSON NOT NULL,
  result_json JSON NULL,
  result_text MEDIUMTEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'running',
  risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
  approval_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idempotency_key VARCHAR(191) NULL,
  attempt INT UNSIGNED NOT NULL DEFAULT 1,
  error_code VARCHAR(16) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  read_only TINYINT(1) NOT NULL DEFAULT 0,
  call_id VARCHAR(191) NULL,
  model_step INT UNSIGNED NULL,
  step_index INT UNSIGNED NULL,
  UNIQUE KEY uk_tool_calls_run_idem (run_id, idempotency_key),
  KEY idx_tool_calls_run (run_id, created_at),
  CONSTRAINT fk_tool_calls_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS run_steps (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq INT UNSIGNED NOT NULL,
  type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  tool_call_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  summary_json JSON NULL,
  error_code VARCHAR(16) NULL,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  UNIQUE KEY uk_run_steps (run_id, seq),
  KEY idx_run_steps_type (run_id, type),
  CONSTRAINT fk_run_steps_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS approvals (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tool_call_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  risk_level VARCHAR(16) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  decided_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  decided_at DATETIME(3) NULL,
  comment VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reason VARCHAR(16) NOT NULL DEFAULT 'policy',
  KEY idx_approvals_status (status, expires_at),
  KEY idx_approvals_run (run_id),
  CONSTRAINT fk_approvals_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS run_events (
  run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq INT UNSIGNED NOT NULL,
  type VARCHAR(64) NOT NULL,
  data_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id, seq),
  KEY idx_run_events_created (created_at),
  CONSTRAINT fk_run_events_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS service_accounts (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'user',
  data_scope VARCHAR(32) NOT NULL DEFAULT 'org',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_service_accounts_key (`key`),
  KEY idx_service_accounts_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS schedules (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  agent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subject_type VARCHAR(16) NOT NULL DEFAULT 'service',
  subject_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_account_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  cron VARCHAR(128) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  input_json JSON NULL,
  version_policy VARCHAR(24) NOT NULL DEFAULT 'published',
  pinned_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  concurrency_policy VARCHAR(24) NOT NULL DEFAULT 'skip',
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(16) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'disabled',
  next_run_at DATETIME(3) NULL,
  last_run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_schedules_key (`key`),
  KEY idx_schedules_due (status, next_run_at),
  CONSTRAINT fk_schedules_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS plugins (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  `key` VARCHAR(128) NOT NULL,
  version VARCHAR(32) NOT NULL,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  manifest_json JSON NOT NULL,
  resources_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_plugins (`key`, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS oidc_role_mappings (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  agent_role_code VARCHAR(100) NOT NULL,
  agent_role_name VARCHAR(100) NOT NULL DEFAULT '',
  local_role VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_oidc_role_mappings (agent_role_code, agent_role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS data_policies (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  role VARCHAR(32) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  actions_json JSON NOT NULL,
  scope_type VARCHAR(24) NOT NULL,
  effect VARCHAR(8) NOT NULL DEFAULT 'allow',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_data_policies (role, resource_type, scope_type, effect)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  actor_name VARCHAR(128) NULL,
  outcome VARCHAR(16) NOT NULL DEFAULT 'success',
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor_type VARCHAR(16) NOT NULL,
  actor_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  details_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  KEY idx_audit_resource (resource_type, resource_id, created_at),
  KEY idx_audit_actor (actor_type, actor_id, created_at),
  KEY idx_audit_action_page (action, created_at, id),
  KEY idx_audit_outcome_page (outcome, created_at, id),
  KEY idx_audit_org (org_unit_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS settings (
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  `key` VARCHAR(128) NOT NULL PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS files (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_type VARCHAR(16) NOT NULL,
  owner_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  storage_path VARCHAR(1024) NOT NULL,
  checksum CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_files_owner (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 007_auth_sessions (session store): keep in sync with scripts/migrate.ts.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  csrf_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  KEY idx_auth_sessions_user (user_id),
  KEY idx_auth_sessions_expires (expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS auth_oidc_states (
  state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  verifier VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  return_to VARCHAR(2048) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  KEY idx_auth_oidc_states_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE IF NOT EXISTS `secrets` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`scope_type` varchar(16) NOT NULL,
	`scope_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
	`scope_resource_type` varchar(32) NOT NULL DEFAULT '',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`active_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `secrets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_secrets_scope` UNIQUE(`scope_type`,`scope_resource_type`,`scope_id`,`key`),
	KEY `idx_secrets_org` (`owner_org_unit_id`,`status`,`id`),
	KEY `idx_secrets_creator` (`created_by`,`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE IF NOT EXISTS `secret_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`secret_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`version` int unsigned NOT NULL,
	`ciphertext` mediumblob NOT NULL,
	`nonce` varbinary(12) NOT NULL,
	`tag` varbinary(16) NOT NULL,
	`encrypted_dek` varbinary(32) NOT NULL,
	`dek_nonce` varbinary(12) NOT NULL,
	`dek_tag` varbinary(16) NOT NULL,
	`key_version` varchar(64) NOT NULL,
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `secret_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_secret_versions` UNIQUE(`secret_id`,`version`),
	CONSTRAINT `fk_secret_versions_secret` FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_secret_versions_key` (`key_version`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE IF NOT EXISTS `resource_references` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`from_type` varchar(32) NOT NULL,
	`from_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`from_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin,
	`to_type` varchar(32) NOT NULL,
	`to_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`to_key` varchar(64) NOT NULL,
	`to_version` varchar(64),
	`binding_key` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `resource_references_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_resource_reference_binding` UNIQUE(`from_type`,`from_id`,`binding_key`),
	KEY `idx_resource_refs_to` (`to_type`,`to_id`),
	KEY `idx_resource_refs_from` (`from_type`,`from_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS auth_login_limits (
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  KEY idx_auth_login_limits_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- 012 global roles and authorization bindings
CREATE TABLE IF NOT EXISTS `permissions` (
	`key` varchar(64) NOT NULL,
	`domain` varchar(32) NOT NULL,
	`kind` varchar(16) NOT NULL DEFAULT 'action',
	`description` varchar(128) NOT NULL,
	CONSTRAINT `permissions_key` PRIMARY KEY(`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `roles` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(32) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`builtin` tinyint NOT NULL DEFAULT 0,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_roles_key` UNIQUE(`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `role_bindings` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`role_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`principal_type` varchar(24) NOT NULL,
	`principal_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`scope_type` varchar(16) NOT NULL DEFAULT 'global',
	`scope_id` varchar(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `role_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_role_bindings` UNIQUE(`role_id`,`principal_type`,`principal_id`,`scope_type`,`scope_id`),
  KEY `idx_role_bindings_principal` (`principal_type`,`principal_id`),
  CONSTRAINT `fk_role_bindings_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `role_permissions` (
	`role_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`permission_key` varchar(64) NOT NULL,
	CONSTRAINT `role_permissions_pk` PRIMARY KEY(`role_id`,`permission_key`),
  CONSTRAINT `fk_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT `fk_role_permissions_permission` FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON DELETE RESTRICT ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Job core expand (014); no external side effects.
CREATE TABLE IF NOT EXISTS `job_definitions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'key',
	`name` varchar(128) NOT NULL COMMENT 'name',
	`description` varchar(1024) NOT NULL DEFAULT '' COMMENT 'description',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	`revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'revision',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'disabled' COMMENT 'status',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	`business_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'business type',
	`responsible_user_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'responsible user id',
	`draft_json` json NOT NULL COMMENT 'draft json',
	`published_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'published version id',
	`next_version` int unsigned NOT NULL DEFAULT 1 COMMENT 'next version',
	CONSTRAINT `job_definitions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_definitions_key` UNIQUE(`key`),
	CONSTRAINT `ck_job_definitions_status` CHECK(`job_definitions`.`status` IN ('active','disabled','deleted')),
	CONSTRAINT `ck_job_definitions_revision` CHECK(`job_definitions`.`revision` > 0 AND `job_definitions`.`next_version` > 0),
	KEY `idx_job_definitions_org` (`owner_org_unit_id`,`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Versioned Job definitions and editable drafts';

CREATE TABLE IF NOT EXISTS `job_definition_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`job_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'job id',
	`version` int unsigned NOT NULL COMMENT 'version',
	`manifest_json` json NOT NULL COMMENT 'Immutable registered target and dependency manifest',
	`manifest_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'manifest hash',
	`policy_json` json NOT NULL COMMENT 'policy json',
	`input_schema_json` json NOT NULL COMMENT 'input schema json',
	`output_schema_json` json NOT NULL COMMENT 'output schema json',
	`published_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'published by',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	CONSTRAINT `job_definition_versions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_definition_versions` UNIQUE(`job_id`,`version`),
	CONSTRAINT `ck_job_version_positive` CHECK(`job_definition_versions`.`version` > 0),
	CONSTRAINT `fk_job_versions_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Immutable published Job versions';

CREATE TABLE IF NOT EXISTS `job_app_grants` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`job_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'job id',
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'app id',
	`actions_json` json NOT NULL COMMENT 'actions json',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'active' COMMENT 'status',
	`revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'revision',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	CONSTRAINT `job_app_grants_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_app_grants` UNIQUE(`job_id`,`app_id`),
	CONSTRAINT `ck_job_grant_status` CHECK(`job_app_grants`.`status` IN ('active','disabled')),
	CONSTRAINT `fk_job_grants_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_job_grants_app` FOREIGN KEY (`app_id`) REFERENCES `api_apps`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_job_app_grants_app` (`app_id`,`status`,`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Explicit API app grants scoped to a Job';

CREATE TABLE IF NOT EXISTS `job_executions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`job_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'job id',
	`job_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'job version id',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`subject_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'subject type',
	`subject_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'subject id',
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'app id',
	`trigger_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'trigger type',
	`trigger_ref` varchar(128) COMMENT 'trigger ref',
	`trigger_actor_json` json NOT NULL COMMENT 'trigger actor json',
	`business_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'business type',
	`business_object_id` varchar(128) NOT NULL COMMENT 'business object id',
	`business_period` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'business period',
	`business_ref_json` json NOT NULL COMMENT 'business ref json',
	`business_key_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Trusted namespaced business key SHA256 retained for durable deduplication',
	`input_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'input hash',
	`round` int unsigned NOT NULL DEFAULT 1 COMMENT 'round',
	`retry_of_execution_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'retry of execution id',
	`runtime_engine` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'runtime engine',
	`snapshot_quality` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'snapshot quality',
	`generation` int unsigned NOT NULL DEFAULT 1 COMMENT 'generation',
	`state_revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'state revision',
	`status` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'queued' COMMENT 'status',
	`wait_reason` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'wait reason',
	`requested_action` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'requested action',
	`input_json` json COMMENT 'Frozen business input; may be purged only after safe retention',
	`snapshot_json` json COMMENT 'Frozen versions, authority ceiling and runtime policy; no secrets',
	`output_json` json COMMENT 'output json',
	`total_count` int unsigned COMMENT 'total count',
	`succeeded_count` int unsigned NOT NULL DEFAULT 0 COMMENT 'succeeded count',
	`failed_count` int unsigned NOT NULL DEFAULT 0 COMMENT 'failed count',
	`unknown_count` int unsigned NOT NULL DEFAULT 0 COMMENT 'unknown count',
	`skipped_count` int unsigned NOT NULL DEFAULT 0 COMMENT 'skipped count',
	`active_ms` bigint unsigned NOT NULL DEFAULT 0 COMMENT 'active ms',
	`active_since` datetime(3) COMMENT 'active since',
	`active_segment_count` int unsigned NOT NULL DEFAULT 0 COMMENT 'Active compute segments; wall-clock union accounting',
	`active_budget_seconds` int unsigned NOT NULL COMMENT 'active budget seconds',
	`wait_deadline_at` datetime(3) COMMENT 'wait deadline at',
	`next_wake_at` datetime(3) COMMENT 'next wake at',
	`cost_usd` decimal(12,6) NOT NULL DEFAULT '0' COMMENT 'cost usd',
	`reserved_cost_usd` decimal(12,6) NOT NULL DEFAULT '0' COMMENT 'reserved cost usd',
	`cost_limit_usd` decimal(12,6) NOT NULL COMMENT 'cost limit usd',
	`delivery_status` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'not_applicable' COMMENT 'delivery status',
	`quality_status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'not_checked' COMMENT 'quality status',
	`delivery_revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'delivery revision',
	`delivery_evidence_json` json COMMENT 'delivery evidence json',
	`next_event_seq` bigint unsigned NOT NULL DEFAULT 1 COMMENT 'Next event sequence allocated under the execution lock',
	`claimed_by` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'claimed by',
	`lease_expires_at` datetime(3) COMMENT 'lease expires at',
	`fence_token` bigint unsigned NOT NULL DEFAULT 0 COMMENT 'Monotonically increasing coordinator ownership fence',
	`error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'error code',
	`error_message` varchar(512) COMMENT 'error message',
	`started_at` datetime(3) COMMENT 'started at',
	`completed_at` datetime(3) COMMENT 'completed at',
	`payload_purged_at` datetime(3) COMMENT 'payload purged at',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	CONSTRAINT `job_executions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_execution_business` UNIQUE(`job_id`,`business_key_hash`,`round`),
	CONSTRAINT `ck_job_execution_status` CHECK(`job_executions`.`status` IN ('queued','running','waiting','pausing','paused','cancelling','succeeded','partial','failed','cancelled','skipped')),
	CONSTRAINT `ck_job_execution_subject` CHECK(`job_executions`.`subject_type` IN ('user','service','app') AND (`job_executions`.`subject_type` <> 'app' OR (`job_executions`.`app_id` IS NOT NULL AND `job_executions`.`app_id` = `job_executions`.`subject_id`))),
	CONSTRAINT `ck_job_execution_engine` CHECK((`job_executions`.`runtime_engine` = 'mysql-agent-bridge' AND `job_executions`.`snapshot_quality` = 'legacy') OR (`job_executions`.`runtime_engine` = 'temporal-job-v1' AND `job_executions`.`snapshot_quality` = 'frozen')),
	CONSTRAINT `ck_job_execution_wait` CHECK((`job_executions`.`status` <> 'waiting' OR `job_executions`.`wait_reason` IS NOT NULL) AND (`job_executions`.`wait_reason` IS NULL OR `job_executions`.`wait_reason` IN ('approval','human','external','reconcile','resource','budget','previous_execution'))),
	CONSTRAINT `ck_job_execution_counts` CHECK(`job_executions`.`generation` BETWEEN 1 AND 4 AND `job_executions`.`round` > 0 AND `job_executions`.`state_revision` > 0 AND `job_executions`.`cost_usd` >= 0 AND `job_executions`.`reserved_cost_usd` >= 0 AND `job_executions`.`cost_limit_usd` > 0),
	CONSTRAINT `ck_job_execution_payload` CHECK((`job_executions`.`input_json` IS NOT NULL AND `job_executions`.`snapshot_json` IS NOT NULL) OR (`job_executions`.`payload_purged_at` IS NOT NULL AND `job_executions`.`status` IN ('succeeded','partial','failed','cancelled','skipped'))),
	CONSTRAINT `ck_job_execution_trigger` CHECK(`job_executions`.`trigger_type` IN ('manual','schedule','api','evaluation')),
	CONSTRAINT `ck_job_execution_action` CHECK(`job_executions`.`requested_action` IS NULL OR `job_executions`.`requested_action` IN ('pause','cancel')),
	CONSTRAINT `ck_job_execution_quality` CHECK(`job_executions`.`quality_status` IN ('not_checked','pass','fail','review')),
	CONSTRAINT `ck_job_execution_delivery` CHECK(`job_executions`.`delivery_status` IN ('not_applicable','pending','delivered','blocked','waived')),
	CONSTRAINT `fk_job_execution_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_job_execution_version` FOREIGN KEY (`job_version_id`) REFERENCES `job_definition_versions`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_job_executions_due` (`status`,`next_wake_at`,`id`),
	KEY `idx_job_executions_lease` (`status`,`lease_expires_at`,`id`),
	KEY `idx_job_executions_org` (`owner_org_unit_id`,`created_at`,`id`),
	KEY `idx_job_executions_subject` (`subject_type`,`subject_id`,`created_at`,`id`),
	KEY `idx_job_executions_app` (`app_id`,`created_at`,`id`),
	KEY `idx_job_executions_job` (`job_id`,`created_at`,`id`),
	KEY `idx_job_executions_business` (`owner_org_unit_id`,`business_type`,`business_object_id`,`created_at`,`id`),
	KEY `idx_job_executions_delivery` (`delivery_status`,`updated_at`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Business executions with frozen input and dependency snapshots';

CREATE TABLE IF NOT EXISTS `job_steps` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`execution_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'execution id',
	`step_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'step key',
	`item_key` varchar(128) NOT NULL DEFAULT '' COMMENT 'item key',
	`item_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'item hash',
	`iteration` int unsigned NOT NULL DEFAULT 0 COMMENT 'iteration',
	`kind` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'kind',
	`generation` int unsigned NOT NULL DEFAULT 1 COMMENT 'generation',
	`state_revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'state revision',
	`status` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'blocked' COMMENT 'status',
	`wait_reason` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'wait reason',
	`error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'error code',
	`error_message` varchar(512) COMMENT 'error message',
	`depends_on_json` json NOT NULL COMMENT 'depends on json',
	`input_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'input hash',
	`input_json` json COMMENT 'Frozen business input; may be purged only after safe retention',
	`result_json` json COMMENT 'result json',
	`result_file_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'result file id',
	`read_only` tinyint NOT NULL COMMENT 'read only',
	`side_effect_state` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'not_submitted' COMMENT 'External action submission and confirmation facts',
	`current_attempt_no` int unsigned NOT NULL DEFAULT 0 COMMENT 'current attempt no',
	`successful_attempt_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'Successful attempt retained across failed-item recovery',
	`available_at` datetime(3) COMMENT 'available at',
	`started_at` datetime(3) COMMENT 'started at',
	`completed_at` datetime(3) COMMENT 'completed at',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	CONSTRAINT `job_steps_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_steps` UNIQUE(`execution_id`,`step_key`,`item_hash`,`iteration`),
	CONSTRAINT `ck_job_step_status` CHECK(`job_steps`.`status` IN ('blocked','ready','dispatched','running','waiting','succeeded','failed','cancelled','skipped')),
	CONSTRAINT `ck_job_step_kind` CHECK(`job_steps`.`kind` IN ('agent','domain','script','browser','external','human','gate','condition','map','join')),
	CONSTRAINT `ck_job_step_effect` CHECK(`job_steps`.`side_effect_state` IN ('not_submitted','submitted','confirmed','unknown')),
	CONSTRAINT `fk_job_step_execution` FOREIGN KEY (`execution_id`) REFERENCES `job_executions`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_job_steps_ready` (`execution_id`,`status`,`available_at`,`id`),
	KEY `idx_job_steps_result` (`result_file_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Logical Job steps and current outcome projections';

CREATE TABLE IF NOT EXISTS `job_step_attempts` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`step_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'step id',
	`attempt_no` int unsigned NOT NULL COMMENT 'attempt no',
	`generation` int unsigned NOT NULL COMMENT 'generation',
	`dispatch_key` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Stable attempt dispatch SHA256 for idempotent recovery',
	`status` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'prepared' COMMENT 'status',
	`side_effect_state` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'not_submitted' COMMENT 'External action submission and confirmation facts',
	`fence_token` bigint unsigned NOT NULL COMMENT 'Monotonically increasing coordinator ownership fence',
	`claimed_by` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'claimed by',
	`lease_expires_at` datetime(3) COMMENT 'lease expires at',
	`run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'run id',
	`code_execution_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'code execution id',
	`external_operation_id` varchar(128) COMMENT 'external operation id',
	`request_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'request hash',
	`result_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'result hash',
	`last_result_message_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'last result message id',
	`input_file_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'input file id',
	`result_json` json COMMENT 'result json',
	`result_file_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'result file id',
	`error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'error code',
	`error_message` varchar(512) COMMENT 'error message',
	`submitted_at` datetime(3) COMMENT 'submitted at',
	`confirmed_at` datetime(3) COMMENT 'confirmed at',
	`completed_at` datetime(3) COMMENT 'completed at',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	CONSTRAINT `job_step_attempts_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job_step_attempt` UNIQUE(`step_id`,`attempt_no`),
	CONSTRAINT `uk_job_dispatch_key` UNIQUE(`dispatch_key`),
	CONSTRAINT `ck_job_attempt_status` CHECK(`job_step_attempts`.`status` IN ('prepared','submitted','running','succeeded','failed','unknown','cancelled')),
	CONSTRAINT `ck_job_attempt_effect` CHECK(`job_step_attempts`.`side_effect_state` IN ('not_submitted','submitted','confirmed','unknown')),
	CONSTRAINT `ck_job_attempt_number` CHECK(`job_step_attempts`.`attempt_no` > 0 AND `job_step_attempts`.`generation` BETWEEN 1 AND 4),
	CONSTRAINT `fk_job_attempt_step` FOREIGN KEY (`step_id`) REFERENCES `job_steps`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_job_step_attempts_lease` (`status`,`lease_expires_at`,`id`),
	KEY `idx_job_step_attempts_run` (`run_id`),
	KEY `idx_job_step_attempts_external` (`external_operation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Append-only attempt facts for a logical Job step';

CREATE TABLE IF NOT EXISTS `job_events` (
	`execution_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'execution id',
	`seq` bigint unsigned NOT NULL COMMENT 'seq',
	`event_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event id',
	`generation` int unsigned NOT NULL COMMENT 'generation',
	`type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'type',
	`data_json` json NOT NULL COMMENT 'data json',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	CONSTRAINT `job_events_execution_id_seq_pk` PRIMARY KEY(`execution_id`,`seq`),
	CONSTRAINT `uk_job_event_id` UNIQUE(`event_id`),
	KEY `idx_job_events_created` (`created_at`,`execution_id`,`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Append-only Job events with persistent sequence';

CREATE TABLE IF NOT EXISTS `outbox_events` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`topic` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'topic',
	`event_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event id',
	`source_type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'source type',
	`source_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'source id',
	`source_seq` bigint unsigned NOT NULL COMMENT 'source seq',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`policy_json` json NOT NULL COMMENT 'policy json',
	`targets_json` json NOT NULL COMMENT 'targets json',
	`payload_json` json NOT NULL COMMENT 'Dispatch references and redacted summaries only',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'pending' COMMENT 'status',
	`attempts` int unsigned NOT NULL DEFAULT 0 COMMENT 'attempts',
	`available_at` datetime(3) NOT NULL COMMENT 'available at',
	`claimed_by` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'claimed by',
	`lease_expires_at` datetime(3) COMMENT 'lease expires at',
	`fence_token` bigint unsigned NOT NULL DEFAULT 0 COMMENT 'Monotonically increasing coordinator ownership fence',
	`error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'error code',
	`processed_at` datetime(3) COMMENT 'processed at',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	CONSTRAINT `outbox_events_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_outbox_event` UNIQUE(`topic`,`event_id`),
	CONSTRAINT `ck_outbox_topic` CHECK(`outbox_events`.`topic` IN ('job.start','job.wake','run.start','message.fanout')),
	CONSTRAINT `ck_outbox_status` CHECK(`outbox_events`.`status` IN ('pending','claimed','processed','failed')),
	KEY `idx_outbox_due` (`status`,`available_at`,`id`),
	KEY `idx_outbox_lease` (`status`,`lease_expires_at`,`id`),
	KEY `idx_outbox_source` (`source_type`,`source_id`,`source_seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Transactional durable dispatch intents';

-- Message management expand (015); no sends or legacy cutover.
CREATE TABLE IF NOT EXISTS `message_channels` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'key',
	`name` varchar(128) NOT NULL COMMENT 'name',
	`description` varchar(1024) NOT NULL DEFAULT '' COMMENT 'description',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	`revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'revision',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'disabled' COMMENT 'status',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	`type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'type',
	`published_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'published version id',
	`next_version` int unsigned NOT NULL DEFAULT 1 COMMENT 'next version',
	`legacy_app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'legacy app id',
	`credential_owner_type` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'credential owner type',
	`credential_owner_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'credential owner id',
	`dispatch_epoch` bigint unsigned NOT NULL DEFAULT 1 COMMENT 'dispatch epoch',
	CONSTRAINT `message_channels_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_channels_key` UNIQUE(`key`),
	CONSTRAINT `uk_message_channels_legacy` UNIQUE(`legacy_app_id`),
	CONSTRAINT `ck_message_channels_status` CHECK(`message_channels`.`status` IN ('active','disabled','deleted')),
	CONSTRAINT `ck_message_channels_type` CHECK(`message_channels`.`type` IN ('webhook','wecom')),
	CONSTRAINT `ck_message_channels_owner` CHECK((`message_channels`.`legacy_app_id` IS NULL AND `message_channels`.`credential_owner_type`='message_channel' AND `message_channels`.`credential_owner_id`=`message_channels`.`id`) OR (`message_channels`.`legacy_app_id` IS NOT NULL AND `message_channels`.`credential_owner_type`='api_app' AND `message_channels`.`credential_owner_id`=`message_channels`.`legacy_app_id`)),
	CONSTRAINT `fk_message_channels_0` FOREIGN KEY (`legacy_app_id`) REFERENCES `api_apps`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_message_channels_org` (`owner_org_unit_id`,`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message channels';

CREATE TABLE IF NOT EXISTS `message_channel_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`channel_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'channel id',
	`version` int unsigned NOT NULL COMMENT 'version',
	`endpoint_secret_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'endpoint secret id',
	`signing_secret_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'signing secret id',
	`header_refs_json` json NOT NULL COMMENT 'header refs json',
	`endpoint_fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'endpoint fingerprint',
	`transport_json` json NOT NULL COMMENT 'transport json',
	`mentioned_ids_json` json NOT NULL COMMENT 'mentioned ids json',
	`mentioned_mobiles_json` json NOT NULL COMMENT 'mentioned mobiles json',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	CONSTRAINT `message_channel_versions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_channel_versions` UNIQUE(`channel_id`,`version`),
	CONSTRAINT `fk_message_channel_versions_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_message_channel_versions_1` FOREIGN KEY (`endpoint_secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_message_channel_versions_2` FOREIGN KEY (`signing_secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message channel versions';

CREATE TABLE IF NOT EXISTS `message_templates` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'key',
	`name` varchar(128) NOT NULL COMMENT 'name',
	`description` varchar(1024) NOT NULL DEFAULT '' COMMENT 'description',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	`revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'revision',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'disabled' COMMENT 'status',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	`draft_json` json NOT NULL COMMENT 'draft json',
	`published_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'published version id',
	`next_version` int unsigned NOT NULL DEFAULT 1 COMMENT 'next version',
	CONSTRAINT `message_templates_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_templates_key` UNIQUE(`key`),
	CONSTRAINT `ck_message_templates_status` CHECK(`message_templates`.`status` IN ('active','disabled','deleted')),
	KEY `idx_message_templates_org` (`owner_org_unit_id`,`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message templates';

CREATE TABLE IF NOT EXISTS `message_template_versions` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`template_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'template id',
	`version` int unsigned NOT NULL COMMENT 'version',
	`format` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'format',
	`content` text NOT NULL COMMENT 'content',
	`variables_json` json NOT NULL COMMENT 'variables json',
	`content_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	CONSTRAINT `message_template_versions_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_template_versions` UNIQUE(`template_id`,`version`),
	CONSTRAINT `ck_message_template_versions_format` CHECK(`message_template_versions`.`format`='wecom_text'),
	CONSTRAINT `fk_message_template_versions_0` FOREIGN KEY (`template_id`) REFERENCES `message_templates`(`id`) ON DELETE restrict ON UPDATE no action
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message template versions';

CREATE TABLE IF NOT EXISTS `message_rules` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`key` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'key',
	`name` varchar(128) NOT NULL COMMENT 'name',
	`description` varchar(1024) NOT NULL DEFAULT '' COMMENT 'description',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`created_by` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'created by',
	`revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'revision',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'disabled' COMMENT 'status',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	`event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event type',
	`scope_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'scope type',
	`scope_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'scope id',
	`channel_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'channel id',
	`template_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'template version id',
	`include_nested_runs` tinyint NOT NULL DEFAULT 0 COMMENT 'include nested runs',
	CONSTRAINT `message_rules_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_rules_key` UNIQUE(`key`),
	CONSTRAINT `ck_message_rules_status` CHECK(`message_rules`.`status` IN ('active','disabled','deleted')),
	CONSTRAINT `ck_message_rules_scope` CHECK((`message_rules`.`scope_type`='global' AND `message_rules`.`scope_id` IS NULL) OR (`message_rules`.`scope_type` IN ('job','agent','api_app','org') AND `message_rules`.`scope_id` IS NOT NULL)),
	CONSTRAINT `fk_message_rules_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_message_rules_1` FOREIGN KEY (`template_version_id`) REFERENCES `message_template_versions`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_message_rules_match` (`event_type`,`status`,`owner_org_unit_id`,`scope_type`,`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message rules';

CREATE TABLE IF NOT EXISTS `message_deliveries` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`event_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event id',
	`event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event type',
	`source_type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'source type',
	`source_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'source id',
	`source_generation` int unsigned NOT NULL DEFAULT 1 COMMENT 'source generation',
	`owner_org_unit_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'owner org unit id',
	`subject_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'subject type',
	`subject_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'subject id',
	`app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'app id',
	`channel_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'channel id',
	`channel_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'channel version id',
	`matched_rules_json` json NOT NULL COMMENT 'matched rules json',
	`template_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'template version id',
	`payload_body` mediumblob COMMENT 'payload body',
	`payload_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'payload hash',
	`status` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'queued' COMMENT 'status',
	`hold_reason` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'hold reason',
	`cancel_requested` tinyint NOT NULL DEFAULT 0 COMMENT 'cancel requested',
	`state_revision` int unsigned NOT NULL DEFAULT 1 COMMENT 'state revision',
	`send_cycle` int unsigned NOT NULL DEFAULT 1 COMMENT 'send cycle',
	`cycle_attempts` int unsigned NOT NULL DEFAULT 0 COMMENT 'cycle attempts',
	`total_attempts` int unsigned NOT NULL DEFAULT 0 COMMENT 'total attempts',
	`next_attempt_at` datetime(3) COMMENT 'next attempt at',
	`claimed_by` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'claimed by',
	`lease_expires_at` datetime(3) COMMENT 'lease expires at',
	`fence_token` bigint unsigned NOT NULL DEFAULT 0 COMMENT 'fence token',
	`authorized_epoch` bigint unsigned NOT NULL DEFAULT 0 COMMENT 'authorized epoch',
	`historical_target_ack` tinyint NOT NULL DEFAULT 0 COMMENT 'historical target ack',
	`first_delivered_at` datetime(3) COMMENT 'first delivered at',
	`last_delivered_at` datetime(3) COMMENT 'last delivered at',
	`last_error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'last error code',
	`legacy_delivery_id` char(26) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'legacy delivery id',
	`legacy_attempts` int unsigned NOT NULL DEFAULT 0 COMMENT 'legacy attempts',
	`payload_purged_at` datetime(3) COMMENT 'payload purged at',
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
	CONSTRAINT `message_deliveries_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_event_channel` UNIQUE(`event_id`,`channel_id`),
	CONSTRAINT `uk_message_legacy_delivery` UNIQUE(`legacy_delivery_id`),
	CONSTRAINT `ck_message_deliveries_status` CHECK(`message_deliveries`.`status` IN ('queued','sending','retry_wait','delivered','failed','unknown','held','cancelled')),
	CONSTRAINT `ck_message_deliveries_payload` CHECK(`message_deliveries`.`payload_body` IS NOT NULL OR `message_deliveries`.`payload_purged_at` IS NOT NULL),
	CONSTRAINT `ck_message_deliveries_held` CHECK(`message_deliveries`.`status`<>'held' OR `message_deliveries`.`hold_reason` IS NOT NULL),
	CONSTRAINT `ck_message_deliveries_cycle` CHECK(`message_deliveries`.`send_cycle`>0 AND `message_deliveries`.`state_revision`>0),
	CONSTRAINT `fk_message_deliveries_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_message_deliveries_1` FOREIGN KEY (`channel_version_id`) REFERENCES `message_channel_versions`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_message_deliveries_due` (`status`,`next_attempt_at`,`id`),
	KEY `idx_message_deliveries_org` (`owner_org_unit_id`,`created_at`,`id`),
	KEY `idx_message_deliveries_source` (`source_type`,`source_id`,`created_at`,`id`),
	KEY `idx_message_deliveries_channel` (`channel_id`,`created_at`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message deliveries';

CREATE TABLE IF NOT EXISTS `message_delivery_attempts` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'id',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	`delivery_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'delivery id',
	`attempt_no` int unsigned NOT NULL COMMENT 'attempt no',
	`send_cycle` int unsigned NOT NULL COMMENT 'send cycle',
	`status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'prepared' COMMENT 'status',
	`channel_version_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'channel version id',
	`endpoint_fingerprint` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'endpoint fingerprint',
	`payload_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'payload hash',
	`fence_token` bigint unsigned NOT NULL COMMENT 'fence token',
	`submitted_at` datetime(3) COMMENT 'submitted at',
	`completed_at` datetime(3) COMMENT 'completed at',
	`response_status` int unsigned COMMENT 'response status',
	`response_summary` varchar(512) COMMENT 'response summary',
	`error_code` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin COMMENT 'error code',
	`retry_after_seconds` int unsigned COMMENT 'retry after seconds',
	`uncertain` tinyint NOT NULL DEFAULT 0 COMMENT 'uncertain',
	CONSTRAINT `message_delivery_attempts_id_pk` PRIMARY KEY(`id`),
	CONSTRAINT `uk_message_delivery_attempt` UNIQUE(`delivery_id`,`attempt_no`),
	CONSTRAINT `ck_message_delivery_attempts_status` CHECK(`message_delivery_attempts`.`status` IN ('prepared','submitted','succeeded','failed','unknown')),
	CONSTRAINT `ck_message_delivery_attempts_number` CHECK(`message_delivery_attempts`.`attempt_no`>0 AND `message_delivery_attempts`.`send_cycle`>0),
	CONSTRAINT `fk_message_delivery_attempts_0` FOREIGN KEY (`delivery_id`) REFERENCES `message_deliveries`(`id`) ON DELETE restrict ON UPDATE no action,
	KEY `idx_message_delivery_attempts_delivery` (`delivery_id`,`attempt_no`),
	KEY `idx_message_delivery_attempts_due` (`status`,`created_at`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message delivery attempts';
