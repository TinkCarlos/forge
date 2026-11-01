ALTER TABLE `agents` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_apps` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `data_policies` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_models` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_providers` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_routes` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_tools` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `oidc_role_mappings` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `org_units` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `plugins` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `service_accounts` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_sources` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tools` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `revision` int unsigned DEFAULT 1 NOT NULL;