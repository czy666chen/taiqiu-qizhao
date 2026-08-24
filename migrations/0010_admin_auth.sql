ALTER TABLE `users` ADD `password_reset_at` integer;
--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_username` text NOT NULL,
	`display_username` text NOT NULL,
	`password_digest` text NOT NULL,
	`password_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "admin_users_id_uuid_length_ck" CHECK(length(`id`) = 36),
	CONSTRAINT "admin_users_username_format_ck" CHECK(length(`normalized_username`) between 3 and 24 and `normalized_username` = lower(`normalized_username`) and `normalized_username` not glob '*[^a-z0-9_]*'),
	CONSTRAINT "admin_users_password_version_ck" CHECK(`password_version` >= 1),
	CONSTRAINT "admin_users_status_ck" CHECK(`status` in ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_normalized_username_uq` ON `admin_users` (`normalized_username`);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "admin_sessions_id_uuid_length_ck" CHECK(length(`id`) = 36)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_digest_uq` ON `admin_sessions` (`token_digest`);
--> statement-breakpoint
CREATE INDEX `admin_sessions_user_expires_idx` ON `admin_sessions` (`admin_user_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `admin_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`outcome` text NOT NULL,
	`request_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "admin_audit_metadata_json_ck" CHECK(json_valid(`metadata_json`)),
	CONSTRAINT "admin_audit_outcome_ck" CHECK(`outcome` in ('success', 'failure'))
);
--> statement-breakpoint
CREATE INDEX `admin_audit_created_idx` ON `admin_audit_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `admin_audit_user_created_idx` ON `admin_audit_events` (`admin_user_id`,`created_at`);
