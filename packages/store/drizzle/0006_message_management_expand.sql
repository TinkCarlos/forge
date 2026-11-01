CREATE TABLE `message_channel_versions` (
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
	CONSTRAINT `uk_message_channel_versions` UNIQUE(`channel_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message channel versions';
--> statement-breakpoint
CREATE TABLE `message_channels` (
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
	CONSTRAINT `ck_message_channels_owner` CHECK((`message_channels`.`legacy_app_id` IS NULL AND `message_channels`.`credential_owner_type`='message_channel' AND `message_channels`.`credential_owner_id`=`message_channels`.`id`) OR (`message_channels`.`legacy_app_id` IS NOT NULL AND `message_channels`.`credential_owner_type`='api_app' AND `message_channels`.`credential_owner_id`=`message_channels`.`legacy_app_id`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message channels';
--> statement-breakpoint
CREATE TABLE `message_deliveries` (
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
	CONSTRAINT `ck_message_deliveries_cycle` CHECK(`message_deliveries`.`send_cycle`>0 AND `message_deliveries`.`state_revision`>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message deliveries';
--> statement-breakpoint
CREATE TABLE `message_delivery_attempts` (
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
	CONSTRAINT `ck_message_delivery_attempts_number` CHECK(`message_delivery_attempts`.`attempt_no`>0 AND `message_delivery_attempts`.`send_cycle`>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message delivery attempts';
--> statement-breakpoint
CREATE TABLE `message_rules` (
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
	CONSTRAINT `ck_message_rules_scope` CHECK((`message_rules`.`scope_type`='global' AND `message_rules`.`scope_id` IS NULL) OR (`message_rules`.`scope_type` IN ('job','agent','api_app','org') AND `message_rules`.`scope_id` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message rules';
--> statement-breakpoint
CREATE TABLE `message_template_versions` (
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
	CONSTRAINT `ck_message_template_versions_format` CHECK(`message_template_versions`.`format`='wecom_text')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message template versions';
--> statement-breakpoint
CREATE TABLE `message_templates` (
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
	CONSTRAINT `ck_message_templates_status` CHECK(`message_templates`.`status` IN ('active','disabled','deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='message templates';
--> statement-breakpoint
ALTER TABLE `message_channel_versions` ADD CONSTRAINT `fk_message_channel_versions_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_channel_versions` ADD CONSTRAINT `fk_message_channel_versions_1` FOREIGN KEY (`endpoint_secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_channel_versions` ADD CONSTRAINT `fk_message_channel_versions_2` FOREIGN KEY (`signing_secret_id`) REFERENCES `secrets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_channels` ADD CONSTRAINT `fk_message_channels_0` FOREIGN KEY (`legacy_app_id`) REFERENCES `api_apps`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD CONSTRAINT `fk_message_deliveries_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD CONSTRAINT `fk_message_deliveries_1` FOREIGN KEY (`channel_version_id`) REFERENCES `message_channel_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_delivery_attempts` ADD CONSTRAINT `fk_message_delivery_attempts_0` FOREIGN KEY (`delivery_id`) REFERENCES `message_deliveries`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_rules` ADD CONSTRAINT `fk_message_rules_0` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_rules` ADD CONSTRAINT `fk_message_rules_1` FOREIGN KEY (`template_version_id`) REFERENCES `message_template_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_template_versions` ADD CONSTRAINT `fk_message_template_versions_0` FOREIGN KEY (`template_id`) REFERENCES `message_templates`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_message_channels_org` ON `message_channels` (`owner_org_unit_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_due` ON `message_deliveries` (`status`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_org` ON `message_deliveries` (`owner_org_unit_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_source` ON `message_deliveries` (`source_type`,`source_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_channel` ON `message_deliveries` (`channel_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_delivery_attempts_delivery` ON `message_delivery_attempts` (`delivery_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_message_delivery_attempts_due` ON `message_delivery_attempts` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_message_rules_match` ON `message_rules` (`event_type`,`status`,`owner_org_unit_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_message_templates_org` ON `message_templates` (`owner_org_unit_id`,`status`,`id`);