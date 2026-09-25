CREATE TABLE `feed_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`feed` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`after_label` text NOT NULL,
	`byline` text NOT NULL,
	`source_url` text,
	`source_ref` text,
	`brief` text,
	`orig_key` text,
	`orig_w` integer,
	`orig_h` integer,
	`her_key` text,
	`her_w` integer,
	`her_h` integer,
	`palettes` text DEFAULT '[]' NOT NULL,
	`variants` text DEFAULT '{}' NOT NULL,
	`saved_at` integer,
	`saved_palette` text,
	`served_at` integer,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`ready_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_feed_cards_feed` ON `feed_cards` (`feed`,`status`,`ready_at`);--> statement-breakpoint
CREATE INDEX `idx_feed_cards_saved` ON `feed_cards` (`saved_at`);--> statement-breakpoint
CREATE INDEX `idx_feed_cards_ref` ON `feed_cards` (`source_ref`);