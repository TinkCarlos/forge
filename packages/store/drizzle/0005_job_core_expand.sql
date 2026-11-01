CREATE TABLE `job_app_grants` (
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
	CONSTRAINT `ck_job_grant_status` CHECK(`job_app_grants`.`status` IN ('active','disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Explicit API app grants scoped to a Job';
--> statement-breakpoint
CREATE TABLE `job_definition_versions` (
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
	CONSTRAINT `ck_job_version_positive` CHECK(`job_definition_versions`.`version` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Immutable published Job versions';
--> statement-breakpoint
CREATE TABLE `job_definitions` (
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
	CONSTRAINT `ck_job_definitions_revision` CHECK(`job_definitions`.`revision` > 0 AND `job_definitions`.`next_version` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Versioned Job definitions and editable drafts';
--> statement-breakpoint
CREATE TABLE `job_events` (
	`execution_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'execution id',
	`seq` bigint unsigned NOT NULL COMMENT 'seq',
	`event_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'event id',
	`generation` int unsigned NOT NULL COMMENT 'generation',
	`type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'type',
	`data_json` json NOT NULL COMMENT 'data json',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) COMMENT 'created at',
	CONSTRAINT `job_events_execution_id_seq_pk` PRIMARY KEY(`execution_id`,`seq`),
	CONSTRAINT `uk_job_event_id` UNIQUE(`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Append-only Job events with persistent sequence';
--> statement-breakpoint
CREATE TABLE `job_executions` (
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
	CONSTRAINT `ck_job_execution_delivery` CHECK(`job_executions`.`delivery_status` IN ('not_applicable','pending','delivered','blocked','waived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Business executions with frozen input and dependency snapshots';
--> statement-breakpoint
CREATE TABLE `job_step_attempts` (
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
	CONSTRAINT `ck_job_attempt_number` CHECK(`job_step_attempts`.`attempt_no` > 0 AND `job_step_attempts`.`generation` BETWEEN 1 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Append-only attempt facts for a logical Job step';
--> statement-breakpoint
CREATE TABLE `job_steps` (
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
	CONSTRAINT `ck_job_step_effect` CHECK(`job_steps`.`side_effect_state` IN ('not_submitted','submitted','confirmed','unknown'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Logical Job steps and current outcome projections';
--> statement-breakpoint
CREATE TABLE `outbox_events` (
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
	CONSTRAINT `ck_outbox_status` CHECK(`outbox_events`.`status` IN ('pending','claimed','processed','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Transactional durable dispatch intents';
--> statement-breakpoint
ALTER TABLE `job_app_grants` ADD CONSTRAINT `fk_job_grants_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_app_grants` ADD CONSTRAINT `fk_job_grants_app` FOREIGN KEY (`app_id`) REFERENCES `api_apps`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_definition_versions` ADD CONSTRAINT `fk_job_versions_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_executions` ADD CONSTRAINT `fk_job_execution_job` FOREIGN KEY (`job_id`) REFERENCES `job_definitions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_executions` ADD CONSTRAINT `fk_job_execution_version` FOREIGN KEY (`job_version_id`) REFERENCES `job_definition_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_step_attempts` ADD CONSTRAINT `fk_job_attempt_step` FOREIGN KEY (`step_id`) REFERENCES `job_steps`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_steps` ADD CONSTRAINT `fk_job_step_execution` FOREIGN KEY (`execution_id`) REFERENCES `job_executions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_job_app_grants_app` ON `job_app_grants` (`app_id`,`status`,`job_id`);--> statement-breakpoint
CREATE INDEX `idx_job_definitions_org` ON `job_definitions` (`owner_org_unit_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_events_created` ON `job_events` (`created_at`,`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_due` ON `job_executions` (`status`,`next_wake_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_lease` ON `job_executions` (`status`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_org` ON `job_executions` (`owner_org_unit_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_subject` ON `job_executions` (`subject_type`,`subject_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_app` ON `job_executions` (`app_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_job` ON `job_executions` (`job_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_business` ON `job_executions` (`owner_org_unit_id`,`business_type`,`business_object_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_executions_delivery` ON `job_executions` (`delivery_status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_step_attempts_lease` ON `job_step_attempts` (`status`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_step_attempts_run` ON `job_step_attempts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_job_step_attempts_external` ON `job_step_attempts` (`external_operation_id`);--> statement-breakpoint
CREATE INDEX `idx_job_steps_ready` ON `job_steps` (`execution_id`,`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_job_steps_result` ON `job_steps` (`result_file_id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_due` ON `outbox_events` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_lease` ON `outbox_events` (`status`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_source` ON `outbox_events` (`source_type`,`source_id`,`source_seq`);