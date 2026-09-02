CREATE TABLE `auth_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`attempts` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `auth_rate_limits_window_idx` ON `auth_rate_limits` (`window_started_at`);
