-- Add tiles.deleted_at for the in-session tile-delete feature.
--
-- Soft-delete pattern: a non-NULL `deleted_at` (unix ms) means the tile
-- is hidden from all read paths but the row stays in DB for debugging.
-- All tile-listing queries are updated in `lib/db/queries.ts` to filter
-- `deleted_at IS NULL` by default. The favorites view does the same so
-- a tile that's both favorited AND soft-deleted disappears from the
-- favorites grid (delete trumps favorite).
--
-- Tiles are cheap to regenerate (just re-Generate with the same presets),
-- so this is one-tier — no user-facing recovery flow. The column exists
-- so we don't have to reckon with FK cascade implications of a hard
-- delete on a still-referenced row, AND so a future periodic cleanup
-- job can sweep aging soft-deleted tile rows + their R2 keys without
-- racing against in-flight reads.
--
-- Index changes:
--   - `idx_tiles_fav` was `(is_favorite, favorited_at) WHERE is_favorite = 1`.
--     Now also filters `deleted_at IS NULL` so the favorites query never has to
--     post-filter.
--   - `idx_tiles_iter_active` is new — covers the dominant tile-stream-per-
--     iteration read path with `deleted_at IS NULL` baked in.
DROP INDEX `idx_tiles_fav`;--> statement-breakpoint
ALTER TABLE `tiles` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `idx_tiles_iter_active` ON `tiles` (`iteration_id`,`idx`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_tiles_fav` ON `tiles` (`is_favorite`,`favorited_at`) WHERE is_favorite = 1 AND deleted_at IS NULL;
