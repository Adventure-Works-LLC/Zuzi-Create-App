/**
 * Drizzle schema. MUST match docs/SCHEMA.md exactly — column names, types, indices.
 *
 * If the schema needs to change:
 *   1. Update docs/SCHEMA.md FIRST.
 *   2. Update this file to match.
 *   3. Run `npm run db:generate` to produce a new migration.
 *   4. Commit both this file and the new migration.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    input_image_key: text("input_image_key").notNull(),
    original_filename: text("original_filename"),
    w: integer("w").notNull(),
    h: integer("h").notNull(),
    aspect_ratio: text("aspect_ratio").notNull(),
    created_at: integer("created_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (t) => [
    index("idx_sources_active")
      .on(t.created_at)
      .where(sql`archived_at IS NULL`),
    index("idx_sources_created").on(t.created_at),
  ],
);

/**
 * Zuzi's reference library of paintings she loves (Sargent, Sorolla,
 * Wyeth, etc.) — used as the second image input in Style Explore mode.
 * Semantically distinct from `sources` (which holds her own work).
 * Same shape as sources (R2-backed input image, sharp-normalized to
 * 2048px JPEG q85) plus optional metadata + soft-archive column.
 *
 * Tag column is unused in v2.1 (filtering deferred to v0.3) but
 * schema-resident so the column doesn't need a follow-up migration
 * when the feature ships.
 */
export const style_paintings = sqliteTable(
  "style_paintings",
  {
    id: text("id").primaryKey(),
    input_image_key: text("input_image_key").notNull(),
    original_filename: text("original_filename"),
    w: integer("w").notNull(),
    h: integer("h").notNull(),
    aspect_ratio: text("aspect_ratio").notNull(),
    title: text("title"),
    artist: text("artist"),
    note: text("note"),
    tag: text("tag"),
    created_at: integer("created_at").notNull(),
    archived_at: integer("archived_at"),
  },
  (t) => [
    index("idx_style_paintings_active")
      .on(t.created_at)
      .where(sql`archived_at IS NULL`),
    index("idx_style_paintings_created").on(t.created_at),
    index("idx_style_paintings_tag")
      .on(t.tag)
      .where(sql`archived_at IS NULL AND tag IS NOT NULL`),
  ],
);

export const iterations = sqliteTable(
  "iterations",
  {
    id: text("id").primaryKey(),
    request_id: text("request_id").notNull().unique(),
    source_id: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /**
     * 'flash' | 'pro' are Gemini tiers. 'flux' (v5) marks sketch_vary
     * iterations, which run on the fal-hosted ZUZQ FLUX LoRA instead of
     * Gemini — it's an engine discriminator for display + cost lookup,
     * not a Gemini tier. 'flux2max' | 'seedream' (v5.4, AGENTS.md §17)
     * are the user-pickable fal engines in the InputBar pill (FLUX 2
     * Max / Seedream 5-Lite edit). Cost paths must branch on tier
     * family BEFORE indexing a pricing matrix (lib/cost.ts covers the
     * four pickable tiers; costForVary covers 'flux').
     */
    model_tier: text("model_tier", {
      enum: ["flash", "pro", "flux", "flux2max", "seedream"],
    })
      .notNull()
      .default("pro"),
    resolution: text("resolution", { enum: ["1k", "4k"] })
      .notNull()
      .default("1k"),
    /**
     * Aspect-ratio mode: 'match' uses the source's aspect ratio (default,
     * preserves the historical AGENTS.md §3 "output aspect == input aspect"
     * invariant); 'flip' swaps W:H so portrait sources generate landscape
     * outputs and vice versa (1:1 stays 1:1). Stored on the iteration so
     * historical rows always render with the right effective aspect even
     * after the flag changes.
     */
    aspect_ratio_mode: text("aspect_ratio_mode", { enum: ["match", "flip"] })
      .notNull()
      .default("match"),
    tile_count: integer("tile_count").notNull().default(3),
    /**
     * JSON array of selected preset strings: 'color' | 'ambiance' |
     * 'lighting' | 'background'. Empty = freeform. Determines the prompt
     * via lib/gemini/imagePrompts.ts buildPrompt().
     */
    presets: text("presets").notNull().default("[]"),
    status: text("status", {
      enum: ["pending", "running", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    /**
     * Iteration mode — discriminates the worker branch.
     *   - 'prompt' (default; v1 behavior): preset-driven via dominator
     *     ladder.
     *   - 'style_explore' (v2): multi-image — sketch + ONE style
     *     painting per tile, fixed Krea-validated directive bypasses
     *     the preset ladder.
     *   - 'style_blend' (v3): multi-image — N style paintings (2..MAX),
     *     NO sketch, fixed directive. Pro generates a brand new painting
     *     from the references' best aspects per its own judgment.
     *   - 'sketch_vary' (v5): the source sketch is run through the
     *     fal-hosted ZUZQ FLUX LoRA (img2img) to settle/perfect the
     *     drawing in Zuzi's own hand — no Gemini call at all. Strength
     *     lives in `vary_strength`. See AGENTS.md §16.
     * Defaults to 'prompt' so existing rows backfill cleanly. See
     * AGENTS.md §13 (Style Explore) + §14 (Style Blend) + §16 (Vary).
     */
    mode: text("mode", {
      enum: ["prompt", "style_explore", "style_blend", "sketch_vary"],
    })
      .notNull()
      .default("prompt"),
    /**
     * v3.4 Style Blend (REWORKED — supersedes the v3.0 blend_style_ids
     * column which was dropped in migration 0008 after the user
     * clarified that "blend" means fusing TILE OUTPUTS, not style
     * library references). JSON array of TILE ids (from previously-
     * generated tiles in this iteration's source) that drove this
     * blend. Populated only when mode='style_blend'; '[]' for every
     * other mode. Stored on the iteration (not per-tile) because every
     * tile in a blend run uses the SAME N input tiles — the variation
     * across blend output tiles comes from Pro's temp 1.0 stochasticity,
     * not from input swap. No FK enforcement (JSON column); the route
     * validates: each id exists, is active (not soft-deleted), AND its
     * iteration belongs to the SAME source as the blend iteration
     * being created (same-source rule). The IterationRow blend
     * attribution looks ids up in the current source's iterations[],
     * which always hits per the same-source rule.
     */
    blend_tile_ids: text("blend_tile_ids").notNull().default("[]"),
    /**
     * v5 sketch_vary (migration 0009): img2img denoise strength for the
     * fal FLUX LoRA call — one of VARY_STRENGTHS (0.45 subtle | 0.60
     * medium | 0.75 wild; validated at the route). NULL for every other
     * mode. Persisted on the iteration (not derived) because boot-time
     * recovery (`instrumentation.ts` → runIteration replay) re-reads the
     * row and must fire the identical fal call the original request
     * asked for.
     */
    vary_strength: real("vary_strength"),
    /**
     * Re-added in migration 0006 (was dropped in v1 cleanup per
     * AGENTS.md §6 as dead weight; now load-bearing again). Set on
     * prompt-mode iterations spawned from a style_explore tile via the
     * lightbox's "Iterate on this direction" handoff — `parent_tile_id`
     * is the style_explore tile id, the iteration's seed reference.
     * ON DELETE SET NULL: deleting the parent tile preserves the
     * spawned iteration; only the provenance link disappears.
     */
    /**
     * v5.6 Style Explore "Her colors" switch. 1 = the keep-source-colors
     * directive variant ran (palette from the sketch, texture only from
     * the style reference); 0 = the original directive (reference brings
     * style AND palette — the default and all pre-v5.6 rows). Persisted
     * per-iteration because boot-time recovery replays re-read the row
     * and must fire the identical prompt, and the IterationRow caption
     * renders the switch state. Meaningful only when
     * mode='style_explore'; always 0 elsewhere (route-enforced).
     */
    keep_source_colors: integer("keep_source_colors").notNull().default(0),
    parent_tile_id: text("parent_tile_id").references(
      (): import("drizzle-orm/sqlite-core").AnySQLiteColumn => tiles.id,
      { onDelete: "set null" },
    ),
    created_at: integer("created_at").notNull(),
    completed_at: integer("completed_at"),
  },
  (t) => [
    index("idx_iter_created").on(t.created_at),
    index("idx_iter_source").on(t.source_id, t.created_at),
    index("idx_iter_parent_tile")
      .on(t.parent_tile_id)
      .where(sql`parent_tile_id IS NOT NULL`),
  ],
);

/** Allowed preset strings stored in iterations.presets JSON. The set is the
 *  canonical, fixed-order list of UI checkboxes. See AGENTS.md §4 for the
 *  preset table + the rationale on why Composition was removed in favor of
 *  Ambiance (composition's reframing operation didn't match the user's
 *  workflow). Don't add Composition back without explicit user request.
 *
 *  `avery` is a painter-reference preset added on top of the original four:
 *  reimagines the painting in Milton Avery's voice while preserving the
 *  figure / subjects exactly. Same locked-body + dominator-routing
 *  architecture as Background and Lighting.
 *
 *  `etching` is a drawing-technique preset: adds classical old-master
 *  shadow hatching (parallel/cross-hatching + soft graphite shading) to
 *  shadow areas only, preserving lit areas + existing lines + the warm
 *  paper background exactly. Same locked-body + dominator-routing
 *  architecture. */
export const PRESETS = [
  "color",
  "ambiance",
  "lighting",
  "background",
  "avery",
  "etching",
] as const;
export type Preset = (typeof PRESETS)[number];

export const tiles = sqliteTable(
  "tiles",
  {
    id: text("id").primaryKey(),
    iteration_id: text("iteration_id")
      .notNull()
      .references(() => iterations.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    output_image_key: text("output_image_key"),
    thumb_image_key: text("thumb_image_key"),
    status: text("status", {
      enum: ["pending", "done", "blocked", "failed"],
    })
      .notNull()
      .default("pending"),
    error_message: text("error_message"),
    is_favorite: integer("is_favorite").notNull().default(0),
    favorited_at: integer("favorited_at"),
    /**
     * Unix-ms timestamp of soft-delete, or NULL if active. All read paths
     * filter `deleted_at IS NULL` so soft-deleted tiles disappear from the
     * stream + favorites view without losing the row (debugging /
     * potential undelete). Tiles are cheap to regenerate so there's no
     * user-facing recovery flow — the column is purely for not having to
     * reckon with the FK cascade implications of hard delete.
     */
    deleted_at: integer("deleted_at"),
    /**
     * Populated per-tile in style_explore-mode iterations — records
     * which style painting was the second image input for this tile.
     * NULL for prompt-mode tiles. Surfaces in the lightbox as the
     * style attribution thumb + powers the "Iterate on this
     * direction" handoff (which propagates this id onto the new
     * iteration). ON DELETE SET NULL: hard-deleting a style painting
     * preserves the tile but the attribution link disappears.
     */
    style_painting_id: text("style_painting_id").references(
      () => style_paintings.id,
      { onDelete: "set null" },
    ),
    created_at: integer("created_at").notNull(),
    completed_at: integer("completed_at"),
  },
  (t) => [
    uniqueIndex("unique_iter_idx").on(t.iteration_id, t.idx),
    index("idx_tiles_iter").on(t.iteration_id),
    index("idx_tiles_fav")
      .on(t.is_favorite, t.favorited_at)
      .where(sql`is_favorite = 1 AND deleted_at IS NULL`),
    // Active-only index: most queries filter by deleted_at IS NULL +
    // iteration_id; partial index keeps it tiny while covering the hot
    // tile-stream-per-iteration read path.
    index("idx_tiles_iter_active")
      .on(t.iteration_id, t.idx)
      .where(sql`deleted_at IS NULL`),
    // Reverse-lookup index for "which tiles were generated against
    // this style painting" — partial because most tiles (prompt mode)
    // are NULL.
    index("idx_tiles_style_painting")
      .on(t.style_painting_id)
      .where(sql`style_painting_id IS NOT NULL`),
  ],
);

export const usage_log = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    iteration_id: text("iteration_id").references(() => iterations.id),
    cost_usd: real("cost_usd").notNull(),
    /**
     * v5.3 (migration 0010): engine tier + completed-call count, written
     * at iteration completion. The Pro daily gauge (/api/usage) sums
     * image_count on model_tier='pro' rows — usage_log survives
     * iteration hard-deletes (only iteration_id gets nullified), unlike
     * tiles, so the gauge doesn't undercount when Zuzi prunes runs.
     * NULL on pre-0010 rows (the gauge treats them as uncounted).
     */
    model_tier: text("model_tier", {
      enum: ["flash", "pro", "flux", "flux2max", "seedream"],
    }),
    image_count: integer("image_count"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_usage_created").on(t.created_at)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type StylePainting = typeof style_paintings.$inferSelect;
export type NewStylePainting = typeof style_paintings.$inferInsert;
export type Iteration = typeof iterations.$inferSelect;
export type NewIteration = typeof iterations.$inferInsert;
export type Tile = typeof tiles.$inferSelect;
export type NewTile = typeof tiles.$inferInsert;
export type UsageLog = typeof usage_log.$inferSelect;
export type NewUsageLog = typeof usage_log.$inferInsert;
