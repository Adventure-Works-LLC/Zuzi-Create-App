-- v2 Style Explore mode — schema foundation. See the plan doc + AGENTS.md
-- §15 (to be added) for the mode contract.
--
-- Four additions, all in one migration so the schema flips atomically:
--
-- 1. `style_paintings` table — Zuzi's reference library of paintings she
--    loves (Sargent, Sorolla, Wyeth, etc.), used as the second image
--    input in Style Explore mode. Semantically distinct from `sources`
--    (which holds her own work-in-progress). Same shape as sources
--    (R2-backed input image, sharp-normalized to 2048px JPEG q85) plus
--    optional title/artist/note/tag metadata + soft-archive column. The
--    `tag` column is unused in v2.1 (filtering deferred to v0.3) but
--    schema-resident so the column doesn't need a follow-up migration
--    when the feature ships.
--
-- 2. `iterations.mode` — enum text column 'prompt' (default) | 'style_explore'.
--    All existing iteration rows backfill cleanly with no behavior change
--    because of the NOT NULL DEFAULT 'prompt'. Style_explore iterations
--    bypass the preset dominator ladder in lib/gemini/imagePrompts.ts —
--    they always use the locked Krea-validated directive (see
--    STYLE_EXPLORE_DIRECTIVE in lib/gemini/runIteration.ts).
--
-- 3. `iterations.parent_tile_id` — re-added after being dropped in v1
--    cleanup per AGENTS.md §6 (was dead weight under the v1 product
--    shape; now load-bearing under v2). Populated on prompt-mode
--    iterations spawned from a style_explore tile via the lightbox's
--    "Iterate on this direction" handoff — the parent_tile_id is the
--    style_explore tile id, so the iteration carries free provenance
--    back to the seed direction. References tiles(id) with the SET NULL
--    semantic intent below.
--
-- 4. `tiles.style_painting_id` — populated per-tile in style_explore-mode
--    iterations, NULL for prompt-mode tiles. Records which style
--    painting was the second image input for each tile so the
--    StyleAttributionThumb can render the source style + the lightbox
--    can swap the "Use as Source" toolbar action to "Iterate on this
--    direction" + the Compare toggle can show result-vs-style. References
--    style_paintings(id) with the SET NULL semantic intent below.
--
-- Three partial indexes for style_paintings mirror the sources pattern:
-- `idx_style_paintings_active` (the hot list-active path),
-- `idx_style_paintings_created` (full chronological scan), and
-- `idx_style_paintings_tag` (deferred filter scaffold). One partial
-- index each for the new FK columns on iterations + tiles, partial
-- because the FK is NULL for most rows (prompt-mode tiles, non-handoff
-- iterations).
--
-- FK enforcement caveat: SQLite does NOT enforce ON DELETE actions added
-- via ALTER TABLE ADD COLUMN (drizzle-kit drops the clause for that
-- reason). The intended semantics are ON DELETE SET NULL for BOTH new
-- FK columns — hard-deleting a style_painting nulls
-- `tiles.style_painting_id` (tile + R2 output preserved, only the
-- attribution link disappears); hard-deleting a tile nulls
-- `iterations.parent_tile_id` (iteration + its own tiles preserved,
-- only the provenance link disappears). Until SQLite supports adding
-- enforced FK actions via ALTER, these are enforced manually via
-- `nullifyTilesForStylePainting` and `nullifyParentTileForReferences`
-- helpers in `lib/db/queries.ts`, called from the DELETE routes. Same
-- pattern as the existing `nullifyUsageLogForSource` / `*ForIteration`
-- helpers for the equally-weak `usage_log.iteration_id` FK.
CREATE TABLE `style_paintings` (
	`id` text PRIMARY KEY NOT NULL,
	`input_image_key` text NOT NULL,
	`original_filename` text,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`aspect_ratio` text NOT NULL,
	`title` text,
	`artist` text,
	`note` text,
	`tag` text,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_style_paintings_active` ON `style_paintings` (`created_at`) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_style_paintings_created` ON `style_paintings` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_style_paintings_tag` ON `style_paintings` (`tag`) WHERE archived_at IS NULL AND tag IS NOT NULL;--> statement-breakpoint
ALTER TABLE `iterations` ADD `mode` text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `iterations` ADD `parent_tile_id` text REFERENCES tiles(id);--> statement-breakpoint
CREATE INDEX `idx_iter_parent_tile` ON `iterations` (`parent_tile_id`) WHERE parent_tile_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tiles` ADD `style_painting_id` text REFERENCES style_paintings(id);--> statement-breakpoint
CREATE INDEX `idx_tiles_style_painting` ON `tiles` (`style_painting_id`) WHERE style_painting_id IS NOT NULL;
