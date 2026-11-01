CREATE TABLE `auth_login_limits` (
	`key_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`window_started_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_login_limits_key_hash` PRIMARY KEY(`key_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `idp_subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `actor_name` varchar(128);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `outcome` varchar(16) DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `idp_issuer` varchar(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;--> statement-breakpoint
CREATE INDEX `idx_auth_login_limits_expires` ON `auth_login_limits` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action_page` ON `audit_logs` (`action`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_outcome_page` ON `audit_logs` (`outcome`,`created_at`,`id`);