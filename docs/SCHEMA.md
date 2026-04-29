# Schema — pinned

SQLite via `better-sqlite3` + Drizzle ORM, on a Railway Volume mounted at `/data`. The DDL
below is the canonical pin. Drizzle schema in `lib/db/schema.ts` (when written in Prompt 3)
must match exactly — column names, types, indices.

If the DDL needs to change, update this file FIRST, then regenerate the Drizzle migration
to match. Never let `lib/db/schema.ts` drift from this file silently.

## DDL

```sql
-- iterations: one "9-tile generation request"
CREATE TABLE iterations (
  id              TEXT PRIMARY KEY,                -- ulid
  request_id      TEXT NOT NULL UNIQUE,            -- client-supplied; idempotency key
  input_image_key TEXT NOT NULL,                   -- R2 key (inputs/<source-ulid>.jpg). Multiple
                                                   -- iterations rows may share an input_image_key —
                                                   -- that's the session-loop shape: same source,
                                                   -- multiple Refresh runs.
  model_tier      TEXT NOT NULL DEFAULT 'pro',     -- 'flash' (cheap exploration) | 'pro' (refined)
  resolution      TEXT NOT NULL DEFAULT '1k',      -- '1k' | '4k'
                                                   -- (model_tier × resolution = the cost cell;
                                                   --  see lib/cost.ts for the 4-tier pricing matrix)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  created_at      INTEGER NOT NULL,                -- unix ms
  completed_at    INTEGER
);
CREATE INDEX idx_iter_created     ON iterations(created_at DESC);
CREATE INDEX idx_iter_input_image ON iterations(input_image_key, created_at DESC);

-- tiles: one of the 9 outputs per iteration
CREATE TABLE tiles (
  id               TEXT PRIMARY KEY,                -- ulid
  iteration_id     TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  idx              INTEGER NOT NULL,                -- 0..8 (position in the 3x3 grid)
  output_image_key TEXT,                            -- R2 key (outputs/<iter_id>/<idx>.jpg); null until done
  thumb_image_key  TEXT,                            -- R2 key (thumbs/<iter_id>/<idx>.webp); null until done
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | done | blocked | failed
  error_message    TEXT,                            -- safety reason / network / etc., when not done
  is_favorite      INTEGER NOT NULL DEFAULT 0,      -- favorites are a primary mechanic (session loop:
                                                    -- generate 9 → favorite 0–3 → refresh → repeat)
  favorited_at     INTEGER,                         -- unix ms when first favorited; null if not
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  UNIQUE(iteration_id, idx)
);
CREATE INDEX idx_tiles_iter ON tiles(iteration_id);
CREATE INDEX idx_tiles_fav  ON tiles(is_favorite, favorited_at DESC) WHERE is_favorite = 1;

-- usage_log: monthly cap enforcement
CREATE TABLE usage_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id TEXT REFERENCES iterations(id),
  cost_usd     REAL NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_usage_created ON usage_log(created_at DESC);
```

## Pragmas (set at boot in `lib/db/client.ts`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
```

## Cuts vs the original plan draft (intentional)

- **No `users` table.** One user, password hash in `ZUZI_PASSWORD_HASH` env var.
- **`is_favorite` is on `tiles`** (was cut once, then restored as a primary mechanic —
  the session loop is generate 9 → favorite 0–3 → refresh → repeat, 4–5 cycles per
  source painting). No separate favorites table; the boolean column is enough at
  one-user scale. `favorited_at` is captured for sort order in the Favorites view.
- **No `preset_tag`, `variation_mode`, `preset_tags`, `prompt_text`, or `parent_tile_id`**
  columns on iterations. The product is the single shared "make this beautiful" prompt
  — no presets, no directive taxonomy, no per-iteration prompt input from the user, no
  branch-from-tile (Refresh = same input_image_key). All planner-era cruft removed.
- **No `prompt_used` column on tiles.** With the single shared prompt every tile in an
  iteration carries the same string — the column was dead weight. The prompt is in
  `lib/gemini/imagePrompt.ts`; if per-tile prompts ever come back, the column comes back.
  Per AGENTS.md §6 schema cleanup principle.
- **`model_tier` and `resolution`** are the only per-iteration cost knobs. Toggled in
  the Studio UI per-iteration. `model_tier` defaults to `'pro'` on the column for
  safety (always-more-expensive default = no surprise bills if the toggle defaults
  wrong). The `IMAGE_MODEL` env var is a fallback only — request body wins.
- **`request_id` UNIQUE index** — used by `POST /api/iterate` to dedupe concurrent
  retries. Client supplies a ulid per logical user action.
- **Multiple `iterations` rows share an `input_image_key`** — that's the session-loop
  data shape. "All runs against this source" = `SELECT * FROM iterations WHERE
  input_image_key = ? ORDER BY created_at` (the new `idx_iter_input_image` covers this).

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
