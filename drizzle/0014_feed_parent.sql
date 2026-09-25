ALTER TABLE `feed_cards` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `idx_feed_cards_parent` ON `feed_cards` (`parent_id`);