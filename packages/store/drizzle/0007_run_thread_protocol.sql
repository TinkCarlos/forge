ALTER TABLE `messages` ADD `thread_seq` bigint unsigned;--> statement-breakpoint
ALTER TABLE `messages` ADD `protocol_version` varchar(32);--> statement-breakpoint
ALTER TABLE `runs` ADD `runtime_engine` varchar(24) DEFAULT 'mysql-legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `snapshot_quality` varchar(16) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `retry_of_run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `runs` ADD `workspace_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `runs` ADD `workflow_id` varchar(128);--> statement-breakpoint
ALTER TABLE `threads` ADD `app_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `threads` ADD `active_run_id` char(26) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `threads` ADD `next_message_seq` bigint unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `revision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `deleted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `uk_messages_thread_seq` UNIQUE(`thread_id`,`thread_seq`);--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `uk_runs_workflow` UNIQUE(`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_engine_status` ON `runs` (`runtime_engine`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_runs_thread_status` ON `runs` (`thread_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_threads_app_created` ON `threads` (`app_id`,`created_at`,`id`);