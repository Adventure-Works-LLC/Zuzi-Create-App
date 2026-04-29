CREATE TABLE `iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`input_image_key` text NOT NULL,
	`model_tier` text DEFAULT 'pro' NOT NULL,
	`resolution` text DEFAULT '1k' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `iterations_request_id_unique` ON `iterations` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_iter_created` ON `iterations` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_iter_input_image` ON `iterations` (`input_image_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `tiles` (
	`id` text PRIMARY KEY NOT NULL,
	`iteration_id` text NOT NULL,
	`idx` integer NOT NULL,
	`output_image_key` text,
	`thumb_image_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`is_favorite` integer DEFAULT 0 NOT NULL,
	`favorited_at` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`iteration_id`) REFERENCES `iterations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_iter_idx` ON `tiles` (`iteration_id`,`idx`);--> statement-breakpoint
CREATE INDEX `idx_tiles_iter` ON `tiles` (`iteration_id`);--> statement-breakpoint
CREATE INDEX `idx_tiles_fav` ON `tiles` (`is_favorite`,`favorited_at`) WHERE is_favorite = 1;--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`iteration_id` text,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`iteration_id`) REFERENCES `iterations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_usage_created` ON `usage_log` (`created_at`);