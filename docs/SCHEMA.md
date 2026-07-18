# Schema — pinned

SQLite via `better-sqlite3` + Drizzle ORM, on a Railway Volume mounted at `/data`. The DDL
below is the canonical pin. Drizzle schema in `lib/db/schema.ts` (when written in Prompt 3)
must match exactly — column names, types, indices.

If the DDL needs to change, update this file FIRST, then regenerate the Drizzle migration
to match. Never let `lib/db/schema.ts` drift from this file silently.

## DDL

```sql
-- sources: one uploaded painting. Sources are the PRIMARY unit; iterations belong to
-- a source. Zuzi may have 3–10 sources in flight at once (the source strip).
CREATE TABLE sources (
  id                TEXT PRIMARY KEY,                -- ulid
  input_image_key   TEXT NOT NULL,                   -- R2 key (inputs/<source-id>.jpg)
  original_filename TEXT,                            -- nullable; preserved when known (paste/drop)
  w                 INTEGER NOT NULL,                -- post-resize dimensions
  h                 INTEGER NOT NULL,
  aspect_ratio      TEXT NOT NULL,                   -- snapped per nearestSupportedAspectRatio
  created_at        INTEGER NOT NULL,                -- unix ms
  archived_at       INTEGER                          -- unix ms when archived; null = active.
                                                     -- Archived sources hide from the strip but
                                                     -- their favorited tiles still appear in the
                                                     -- global Favorites view.
);
CREATE INDEX idx_sources_active  ON sources(created_at) WHERE archived_at IS NULL;
CREATE INDEX idx_sources_created ON sources(created_at);

-- style_paintings: Zuzi's reference library (Sargent, Sorolla, Wyeth, etc.)
-- used as the SECOND image input in Style Explore mode. Semantically
-- distinct from sources (her own work-in-progress). Same shape as sources
-- plus optional metadata + a tag column scaffolded for v0.3 filtering.
CREATE TABLE style_paintings (
  id                TEXT PRIMARY KEY,                -- ulid
  input_image_key   TEXT NOT NULL,                   -- R2 key (styles/<style-id>.jpg)
  original_filename TEXT,                            -- nullable; preserved when known
  w                 INTEGER NOT NULL,                -- post-resize dimensions
  h                 INTEGER NOT NULL,
  aspect_ratio      TEXT NOT NULL,                   -- snapped per nearestSupportedAspectRatio
                                                     -- (informational; the SKETCH wins per AGENTS.md §3
                                                     -- when this painting is the second image input)
  title             TEXT,                            -- optional ("Lady Agnew", "Naranjas y Limones", …)
  artist            TEXT,                            -- optional (defer editing UI to v0.2)
  note              TEXT,                            -- optional freeform (defer UI to v0.2)
  tag               TEXT,                            -- optional; UNUSED in v2.1; scaffolded for v0.3 filter
  created_at        INTEGER NOT NULL,
  archived_at       INTEGER                          -- unix ms when archived; null = active
);
CREATE INDEX idx_style_paintings_active  ON style_paintings(created_at) WHERE archived_at IS NULL;
CREATE INDEX idx_style_paintings_created ON style_paintings(created_at);
CREATE INDEX idx_style_paintings_tag     ON style_paintings(tag)
  WHERE archived_at IS NULL AND tag IS NOT NULL;

-- iterations: one "N-tile generation request" against a source (N defaults to 3)
CREATE TABLE iterations (
  id                 TEXT PRIMARY KEY,                -- ulid
  request_id         TEXT NOT NULL UNIQUE,            -- client-supplied; idempotency key
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                                                      -- multiple iterations per source = the session
                                                      -- loop. Cascade so deleting a source removes
                                                      -- its iterations + tiles automatically.
  model_tier         TEXT NOT NULL DEFAULT 'pro',     -- 'flash' (cheap exploration) | 'pro' (refined)
                                                      -- | 'flux' (v5: sketch_vary iterations only —
                                                      --   the ZUZQ LoRA engine, not a Gemini tier)
                                                      -- | 'flux2max' | 'seedream' (v5.4: user-picked
                                                      --   fal engines in the tier pill — AGENTS.md §17)
  resolution         TEXT NOT NULL DEFAULT '1k',      -- '1k' | '4k'
                                                      -- (model_tier × resolution = the cost cell;
                                                      --  see lib/cost.ts for the 4-tier pricing matrix)
  tile_count         INTEGER NOT NULL DEFAULT 3,      -- number of tiles per Submit (default 3,
                                                      -- configurable via TILE_COUNT_DEFAULT in
                                                      -- lib/cost.ts)
  presets            TEXT NOT NULL DEFAULT '[]',      -- JSON array of selected preset strings:
                                                      -- 'color' | 'ambiance' | 'lighting' |
                                                      -- 'background' | 'avery' | 'etching'. Empty =
                                                      -- freeform (model chooses everything). Determines
                                                      -- prompt via lib/gemini/imagePrompts.ts buildPrompt().
                                                      -- Ignored when mode='style_explore' (see below).
  aspect_ratio_mode  TEXT NOT NULL DEFAULT 'match',   -- 'match' (preserves source aspect per AGENTS.md §3)
                                                      -- | 'flip' (swaps W:H; 1:1 stays 1:1)
  mode               TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt' (v1 default, preset-driven) |
                                                      -- 'style_explore' (multi-image: source + style
                                                      -- painting, fixed Krea-validated directive
                                                      -- bypasses the preset dominator ladder) |
                                                      -- 'style_blend' (v3.4: fuse N tile outputs,
                                                      -- ids in blend_tile_ids) |
                                                      -- 'sketch_vary' (v5: FLUX LoRA settle/perfect
                                                      -- pass on the source sketch — see AGENTS.md §16)
  blend_tile_ids     TEXT NOT NULL DEFAULT '[]',      -- v3.4 (migration 0008): JSON array of TILE ids
                                                      -- fused by a style_blend iteration. '[]' for
                                                      -- every other mode. No FK enforcement (JSON);
                                                      -- the route validates existence + 'done'.
  vary_strength      REAL,                            -- v5 (migration 0009): img2img denoise strength
                                                      -- for sketch_vary iterations (0.45 subtle |
                                                      -- 0.60 medium | 0.75 wild). NULL for every other
                                                      -- mode. Persisted so boot-time recovery replays
                                                      -- fire the identical fal call.
  keep_source_colors INTEGER NOT NULL DEFAULT 0,      -- v5.6 (migration 0011): Style Explore "Her
                                                      -- colors" switch. 1 = keep-source-colors
                                                      -- directive variant (palette from the sketch,
                                                      -- texture only from the reference). 0 = the
                                                      -- original directive + all pre-v5.6 rows.
                                                      -- Only meaningful when mode='style_explore'.
  loose              INTEGER NOT NULL DEFAULT 0,      -- v5.7 (migration 0012): Style Explore "Loose"
                                                      -- switch. 1 = subtractive loose directive
                                                      -- (preservation clauses deleted; the model may
                                                      -- alter her drawing). Composes with
                                                      -- keep_source_colors (4-way directive select).
                                                      -- Only meaningful when mode='style_explore'.
  parent_tile_id     TEXT REFERENCES tiles(id),       -- See note on FK enforcement below. Populated on
                                                      -- prompt-mode iterations spawned from a
                                                      -- style_explore tile via the lightbox's "Iterate
                                                      -- on this direction" handoff. NULL otherwise.
                                                      -- Semantic intent: ON DELETE SET NULL.
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  created_at         INTEGER NOT NULL,                -- unix ms
  completed_at       INTEGER
);
CREATE INDEX idx_iter_created     ON iterations(created_at);
CREATE INDEX idx_iter_source      ON iterations(source_id, created_at);
CREATE INDEX idx_iter_parent_tile ON iterations(parent_tile_id) WHERE parent_tile_id IS NOT NULL;

-- tiles: one of the N outputs per iteration
CREATE TABLE tiles (
  id                 TEXT PRIMARY KEY,                -- ulid
  iteration_id       TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL,                -- 0..N-1 (position in the grid)
  output_image_key   TEXT,                            -- R2 key (outputs/<iter_id>/<idx>.jpg); null until done
  thumb_image_key    TEXT,                            -- R2 key (thumbs/<iter_id>/<idx>.webp); null until done
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | done | blocked | failed
  error_message      TEXT,                            -- safety reason / network / etc., when not done
  is_favorite        INTEGER NOT NULL DEFAULT 0,      -- favorites are a primary mechanic (session loop:
                                                      -- generate N → favorite 0–N → refresh → repeat)
  favorited_at       INTEGER,                         -- unix ms when first favorited; null if not
  deleted_at         INTEGER,                         -- unix ms; soft-delete (filters all read paths)
  style_painting_id  TEXT REFERENCES style_paintings(id),
                                                      -- See note on FK enforcement below. Populated per-tile
                                                      -- on style_explore-mode iterations, NULL for prompt
                                                      -- mode. Powers the StyleAttributionThumb + the
                                                      -- "Iterate on this direction" handoff.
                                                      -- Semantic intent: ON DELETE SET NULL.
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  UNIQUE(iteration_id, idx)
);
CREATE INDEX idx_tiles_iter            ON tiles(iteration_id);
CREATE INDEX idx_tiles_iter_active     ON tiles(iteration_id, idx)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_tiles_fav             ON tiles(is_favorite, favorited_at)
  WHERE is_favorite = 1 AND deleted_at IS NULL;
CREATE INDEX idx_tiles_style_painting  ON tiles(style_painting_id)
  WHERE style_painting_id IS NOT NULL;
-- All indexes use ASC ordering (Drizzle's `.on(col)` default). Queries that ORDER BY
-- DESC (Favorites view, source strip, history) use SQLite's index reverse-scan —
-- same result, negligible perf cost at this scale (~10–100 sources, ~1000s of tiles
-- lifetime). If we migrate to Postgres or hit planner regressions, revisit DESC.

-- usage_log: monthly cap enforcement + daily quota gauge
CREATE TABLE usage_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT REFERENCES iterations(id),
  cost_usd     REAL NOT NULL,
  model_tier   TEXT,                -- v5.3 (migration 0010): 'flash' | 'pro' | 'flux'.
                                    -- NULL on pre-0010 rows. Written at completion so
                                    -- the Pro daily gauge survives iteration deletes
                                    -- (tiles vanish on hard delete; usage_log rows only
                                    -- get iteration_id nullified).
  image_count  INTEGER,             -- v5.3: completed Gemini/fal calls this iteration
                                    -- consumed (done + blocked tiles; 429-rejected
                                    -- calls consume no quota and aren't counted).
                                    -- NULL on pre-0010 rows.
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_usage_created ON usage_log(created_at);
```

## Pragmas (set at boot in `lib/db/client.ts`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
```

## Cuts vs the original plan draft (intentional)

- **No `users` table.** One user, password hash in `ZUZI_PASSWORD_HASH` env var.
- **`sources` is the primary unit, not `iterations`.** Zuzi runs 3–10 sources in
  parallel (the source strip). Iterations belong to a source via `source_id` FK.
  `iterations.input_image_key` was removed — the source row is the source of truth for
  the R2 key.
- **`sources.archived_at`** is a soft-delete: archived sources hide from the active
  strip (`WHERE archived_at IS NULL`) but their tiles still surface in the global
  Favorites view. The partial index `idx_sources_active` makes the strip query fast.
- **`is_favorite` + `favorited_at` on `tiles`.** Favorites are a primary mechanic and
  span all sources (active + archived). No separate favorites table; the boolean +
  timestamp columns are enough at one-user scale. Partial index
  `idx_tiles_fav` keeps the Favorites view query fast as the table grows.
- **No `preset_tag`, `variation_mode`, `preset_tags`, or `prompt_text`**
  columns on iterations (`parent_tile_id` was also in this cut list in v1
  but was RE-ADDED in v2 for the "Iterate on this direction" handoff — see
  the v2 additions note below). The product is the single shared "make this beautiful" prompt
  — no presets, no directive taxonomy, no per-iteration prompt input from the user, no
  branch-from-tile. All planner-era cruft removed.
- **No `prompt_used` column on tiles.** With the single shared prompt every tile in an
  iteration carries the same string — the column was dead weight. The prompt is in
  `lib/gemini/imagePrompts.ts`; if per-tile prompts ever come back, the column comes back.
  Per AGENTS.md §6 schema cleanup principle.
- **`model_tier` and `resolution`** are the only per-iteration cost knobs. Toggled in
  the Studio UI per-iteration. `model_tier` defaults to `'pro'` on the column for
  safety (always-more-expensive default = no surprise bills if the toggle defaults
  wrong). The `IMAGE_MODEL` env var is a fallback only — request body wins.
- **`request_id` UNIQUE index** — used by `POST /api/iterate` to dedupe concurrent
  retries. Client supplies a ulid per logical user action.
- **v2 additions (`iterations.mode` + `iterations.parent_tile_id` + `tiles.style_painting_id`).**
  Per AGENTS.md §6 schema cleanup principle, `parent_tile_id` was dropped in v1 as
  dead weight; v2 re-adds it because the "Iterate on this direction" handoff makes
  it load-bearing for provenance. `mode` discriminates the worker branch
  (prompt vs style_explore); style_explore iterations bypass the preset dominator
  ladder and use the fixed Krea-validated directive. `tiles.style_painting_id`
  powers the StyleAttributionThumb + lightbox handoff.

## FK enforcement caveat (v2 columns)

The intended ON DELETE semantic for both `iterations.parent_tile_id` and
`tiles.style_painting_id` is **SET NULL**:
- Hard-deleting a style_painting nulls `tiles.style_painting_id` so referenced
  tiles + their R2 outputs are preserved; only the attribution link disappears.
- Hard-deleting a tile nulls `iterations.parent_tile_id` so the spawned iteration
  + its own tiles are preserved; only the provenance link disappears.

SQLite does NOT enforce ON DELETE actions added via `ALTER TABLE ADD COLUMN`
(drizzle-kit drops the clause for that reason — see the auto-generated
migration `drizzle/0006_add_style_explore.sql`). These actions are enforced
manually via `nullifyTilesForStylePainting` (for `tiles.style_painting_id`)
and `nullifyParentTileForTileIds` / `nullifyParentTileForIteration` /
`nullifyParentTileForSource` (for `iterations.parent_tile_id`, scoped to
the three hard-delete cascade levels) in `lib/db/queries.ts`, called from
the DELETE routes inside the same transaction as the delete itself. Same
pattern as the existing `nullifyUsageLogForSource` / `*ForIteration` helpers
that work around the equally-weak `usage_log.iteration_id` FK.

## Common queries

```sql
-- Source strip (active sources, newest first), with run + favorite counts:
SELECT s.id, s.input_image_key, s.w, s.h, s.aspect_ratio, s.created_at,
       COUNT(DISTINCT i.id)                              AS iteration_count,
       COUNT(t.id) FILTER (WHERE t.is_favorite = 1)      AS favorite_count
  FROM sources s
  LEFT JOIN iterations i ON i.source_id = s.id
  LEFT JOIN tiles      t ON t.iteration_id = i.id
 WHERE s.archived_at IS NULL
 GROUP BY s.id
 ORDER BY s.created_at
 LIMIT 20;

-- Favorites across ALL sources (active + archived) for the global Favorites view:
SELECT t.id AS tile_id, t.iteration_id, t.idx, t.thumb_image_key, t.output_image_key,
       t.favorited_at, t.created_at,
       i.model_tier, i.resolution,
       s.id AS source_id, s.archived_at IS NOT NULL AS source_archived
  FROM tiles t
  JOIN iterations i ON i.id = t.iteration_id
  JOIN sources    s ON s.id = i.source_id
 WHERE t.is_favorite = 1
 ORDER BY t.favorited_at DESC
 LIMIT 50;
```

## Recovery file (not in DB, lives on the Volume)

`/data/recovery.jsonl` — append-only log written by `runIteration` AFTER each successful
Gemini response and BEFORE the corresponding `UPDATE tiles SET status='done'`. Each line:

```json
{"iter_id": "<ulid>", "idx": 0, "r2_key": "outputs/<iter_id>/0.jpg", "ts": 1714347600000}
```

Boot-time sweep (`instrumentation.ts`): for any tile older than 5 minutes still
`pending`, look up `iter_id` + `idx` in the JSONL. If found, rehydrate the row with the
recovered `r2_key` (we already paid for that image). If not found, mark `failed` with
`error_message='server_restart'`. The JSONL parser silently drops a trailing partial
line (a crash mid-write leaves at most one corrupt line at the tail).

The DB is the source of truth; `recovery.jsonl` is just the bridge for the narrow window
between "Gemini returned bytes" and "row is updated".

## Backups (Prompt 6)

Nightly `sqlite3 /data/zuzi.db ".backup /tmp/zuzi-<ts>.db"` then `aws s3 cp` to R2 backup
bucket. R2 lifecycle policy deletes after 30 days. Per `scripts/backup.sh` (TODO).
