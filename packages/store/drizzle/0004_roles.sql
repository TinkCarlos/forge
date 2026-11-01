CREATE TABLE `permissions` (
	`key` varchar(64) NOT NULL,
	`domain` varchar(32) NOT NULL,
	`kind` varchar(16) NOT NULL DEFAULT 'action',
	`description` varchar(128) NOT NULL,
	CONSTRAINT `permissions_key` PRIMARY KEY(`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `role_bindings` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`role_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`principal_type` varchar(24) NOT NULL,
	`principal_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`scope_type` varchar(16) NOT NULL DEFAULT 'global',
	`scope_id` varchar(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `role_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_role_bindings` UNIQUE(`role_id`,`principal_type`,`principal_id`,`scope_type`,`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`permission_key` varchar(64) NOT NULL,
	CONSTRAINT `role_permissions_pk` PRIMARY KEY(`role_id`,`permission_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` char(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`key` varchar(32) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(1024) NOT NULL DEFAULT '',
	`builtin` tinyint NOT NULL DEFAULT 0,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_roles_key` UNIQUE(`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `role_bindings` ADD CONSTRAINT `fk_role_bindings_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `fk_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `fk_role_permissions_permission` FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_role_bindings_principal` ON `role_bindings` (`principal_type`,`principal_id`);