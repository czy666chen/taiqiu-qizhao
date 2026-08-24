CREATE INDEX `matches_created_idx` ON `matches` (`created_at`);
--> statement-breakpoint
CREATE INDEX `matches_status_created_idx` ON `matches` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `matches_owner_created_idx` ON `matches` (`owner_user_id`,`created_at`);
