CREATE TABLE IF NOT EXISTS org_units (
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
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'user',
  data_scope VARCHAR(16) NOT NULL DEFAULT 'self',
  org_unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idp_subject VARCHAR(255) NULL,
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
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  UNIQUE KEY uk_webhook_delivery_event (app_id, event_id),
  KEY idx_webhook_delivery_due (status, next_attempt_at),
  CONSTRAINT fk_webhook_deliveries_app FOREIGN KEY (app_id) REFERENCES api_apps (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agents (
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
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  server_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NOT NULL DEFAULT '',
  input_schema_json JSON NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'medium',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_mcp_tools (server_id, name),
  CONSTRAINT fk_mcp_tools_server FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tool_sources (
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
  UNIQUE KEY uk_tools (source_id, name),
  CONSTRAINT fk_tools_source FOREIGN KEY (source_id) REFERENCES tool_sources (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS llm_providers (
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
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  agent_role_code VARCHAR(100) NOT NULL,
  agent_role_name VARCHAR(100) NOT NULL DEFAULT '',
  local_role VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_oidc_role_mappings (agent_role_code, agent_role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS data_policies (
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
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor_type VARCHAR(16) NOT NULL,
  actor_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  details_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_resource (resource_type, resource_id, created_at),
  KEY idx_audit_actor (actor_type, actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS settings (
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

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
