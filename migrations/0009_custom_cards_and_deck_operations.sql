CREATE TABLE `custom_cards` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `title` text NOT NULL,
  `effect` text NOT NULL,
  `default_quantity` integer DEFAULT 1 NOT NULL,
  `safety_level` text DEFAULT 'low' NOT NULL,
  `safety_note` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
  CONSTRAINT `custom_cards_quantity_ck` CHECK(`default_quantity` between 1 and 10),
  CONSTRAINT `custom_cards_safety_level_ck` CHECK(`safety_level` in ('low', 'medium', 'review'))
);
--> statement-breakpoint
CREATE INDEX `custom_cards_owner_deleted_updated_idx` ON `custom_cards` (`owner_user_id`,`deleted_at`,`updated_at`);
--> statement-breakpoint
ALTER TABLE `deck_versions` ADD `operation_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `deck_versions_operation_uq` ON `deck_versions` (`operation_id`);
