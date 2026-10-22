export interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  role: string;
  data_scope: string;
  org_unit_id: string | null;
  idp_subject: string | null;
  status: string;
  is_emergency_admin: number;
  created_at: Date;
}

export interface AgentRow {
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
}

export interface ProviderRow {
  id: string;
  key: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key_encrypted: string | null;
  headers_json: unknown;
  timeout_ms: number;
  status: string;
}

export interface ModelRow {
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
