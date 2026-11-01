export interface ApiAppRow extends Record<string, unknown> {
  revision: number;
  id: string; key: string; name: string; status: string; scopes_json: string[]; webhook_url: string | null; webhook_secret_id?: string | null;
  owner_org_unit_id: string | null; rate_limit_per_minute: number; daily_quota: number; created_at: Date;
}
export interface ApiKeyMetadataRow {
  id: string; app_id: string; name: string; prefix: string; scopes_json: string[]; status: string;
  expires_at: Date | null; last_used_at: Date | null; created_at: Date;
}

export interface RoleRow {
  id: string; key: string; name: string; description: string; builtin: number; status: string; revision: number;
  permissions_json: string[]; created_at: Date; updated_at: Date;
}

export interface UserRow {
  authorization_json?: unknown;
  revision: number;
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  role: string;
  data_scope: string;
  org_unit_id: string | null;
  idp_subject: string | null;
  idp_issuer?: string | null;
  status: string;
  is_emergency_admin: number;
  created_at: Date;
  updated_at: Date;
}

/** Data-scope filter for user lists: `{}` = all users; `orgIds` = users in these departments; `userId` = only this user. */
export interface UserFilter {
  orgIds?: string[];
  userId?: string;
}

export interface AgentRow {
  revision: number;
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  owner_org_unit_id: string | null;
  latest_version_id: string | null;
  published_version_id: string | null;
  api_enabled: number;
  api_scopes_json: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface AgentVersionRow {
  id: string;
  agent_id: string;
  version: string;
  status: string;
  instructions: string;
  spec_json: unknown;
  changelog: string;
  created_at: Date;
  published_at: Date | null;
}

export interface RunRow {
  runtime_engine?: string;
  snapshot_quality?: string;
  retry_of_run_id?: string|null;
  workspace_id?: string|null;
  workflow_id?: string|null;
  id: string;
  thread_id: string;
  agent_id: string;
  agent_version_id: string;
  app_id: string | null;
  org_unit_id: string | null;
  subject_type: string;
  subject_id: string;
  status: string;
  trigger_type: string;
  trigger_ref: string | null;
  input_json: unknown;
  output_json: unknown;
  usage_json: unknown;
  cost_usd: string | number;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: number;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface MessageRow {
  thread_seq?: string|null;
  protocol_version?: string|null;
  id: string;
  thread_id: string;
  run_id: string;
  seq: number;
  role: string;
  content_json: unknown;
  created_at: Date;
}

export interface ToolCallRow {
  id: string;
  run_id: string;
  tool_key: string;
  args_json: unknown;
  result_json: unknown;
  result_text: string | null;
  status: string;
  risk_level: string;
  approval_id: string | null;
  idempotency_key: string | null;
  attempt: number;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  /** 008: readOnly snapshot at creation (1 = read-only, 0 = has side effects). */
  read_only: number;
  /** 008 (Q5): the provider's tool call id, audit only (never a lookup key, never replayed). */
  call_id: string | null;
  /** 008 (Q5): run_steps.seq of the call_model step that produced the call; NULL for rows written before 008. */
  model_step: number | null;
  /** 008 (Q5): index of the call in that step's toolCalls (from 0); NULL for rows written before 008. */
  step_index: number | null;
}

export interface RunStepRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  status: string;
  tool_call_id: string | null;
  summary_json: unknown;
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | number;
  started_at: Date;
  ended_at: Date | null;
}

export interface ClaimedRun {
  run: RunRow;
  previousStatus: string;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  tool_call_id: string;
  status: string;
  risk_level: string;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  comment: string | null;
  created_at: Date;
  /** 008: why the approval exists; rows written before 008 (or by older code) read 'policy'. */
  reason: "policy" | "interrupted";
}

export interface ProviderRow {
  revision: number;
  id: string;
  key: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key_encrypted: string | null;
  secret_id?: string | null;
  header_secret_refs_json?: unknown;
  headers_json: unknown;
  timeout_ms: number;
  status: string;
}

export interface ModelRow {
  revision: number;
  id: string;
  provider_id: string;
  key: string;
  display_name: string;
  capabilities_json: unknown;
  context_window: number;
  max_output_tokens: number;
  input_price_per_mtok: string | number;
  output_price_per_mtok: string | number;
  status: string;
}

export interface ServiceAccountRow {
  authorization_json?: unknown;
  revision: number;
  id: string;
  key: string;
  name: string;
  description: string;
  org_unit_id: string | null;
  role: string;
  data_scope: string;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}
