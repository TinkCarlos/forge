CREATE TABLE `resource_references` (
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
	CONSTRAINT `uk_resource_reference_binding` UNIQUE(`from_type`,`from_id`,`binding_key`)
);
--> statement-breakpoint
CREATE TABLE `secret_versions` (
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
	CONSTRAINT `uk_secret_versions` UNIQUE(`secret_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `secrets` (
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
	CONSTRAINT `uk_secrets_scope` UNIQUE(`scope_type`,`scope_resource_type`,`scope_id`,`key`)
);
--> statement-breakpoint
ALTER TABLE `api_apps` ADD `webhook_secret_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `llm_providers` ADD `secret_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `llm_providers` ADD `header_secret_refs_json` json;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `header_secret_refs_json` json;--> statement-breakpoint
ALTER TABLE `tool_sources` ADD `header_secret_refs_json` json;--> statement-breakpoint
ALTER TABLE `secret_versions` ADD CONSTRAINT `fk_secret_versions_secret` FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_resource_refs_to` ON `resource_references` (`to_type`,`to_id`);--> statement-breakpoint
CREATE INDEX `idx_resource_refs_from` ON `resource_references` (`from_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_secret_versions_key` ON `secret_versions` (`key_version`,`id`);--> statement-breakpoint
CREATE INDEX `idx_secrets_org` ON `secrets` (`owner_org_unit_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_secrets_creator` ON `secrets` (`created_by`,`status`,`id`);