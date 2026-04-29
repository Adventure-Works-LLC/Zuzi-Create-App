ALTER TABLE `iterations` ADD `tile_count` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `iterations` ADD `presets` text DEFAULT '[]' NOT NULL;