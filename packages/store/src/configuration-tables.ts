export const REVISION_009_TABLES = [
  "agents", "skills", "mcp_servers", "mcp_tools", "tool_sources", "tools", "llm_providers", "llm_models", "llm_routes",
  "api_apps", "users", "service_accounts", "schedules", "oidc_role_mappings", "plugins", "org_units", "data_policies", "settings",
] as const;
export const CONFIGURATION_TABLES = [...REVISION_009_TABLES, "secrets", "roles"] as const;
export type ConfigurationTable = (typeof CONFIGURATION_TABLES)[number];
export type RevisionExpectation = number | "system";
