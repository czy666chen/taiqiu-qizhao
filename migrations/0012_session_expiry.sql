ALTER TABLE `sessions` ADD `expires_at` integer;--> statement-breakpoint
UPDATE `sessions`
   SET `expires_at` = `created_at` + 34560000000
 WHERE `expires_at` IS NULL;--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
