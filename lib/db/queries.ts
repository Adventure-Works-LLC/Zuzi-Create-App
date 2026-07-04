/**
 * Typed query helpers. Every code path that reads or writes the DB goes through here —
 * keeps Drizzle queries in one place and gives a stable seam for tests.
 *
 * Conventions:
 *   - All timestamps are unix ms.
 *   - All ids are ulids (text).
 *   - Functions return plain rows / row arrays; callers shape the response.
 */

import { and, count, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "./client";
import {
  iterations,
  sources,
  style_paintings,
  tiles,
  usage_log,
  type Iteration,
  type NewIteration,
  type NewSource,
  type NewStylePainting,
  type NewTile,
  type Source,
  type StylePainting,
  type Tile,
} from "./schema";

// ---------- sources ----------

export function insertSource(row: NewSource): void {
  db().insert(sources).values(row).run();
}

export function getSource(id: string): Source | undefined {
  return db().select().from(sources).where(eq(sources.id, id)).get();
}

export function setSourceArchived(id: string, archived: boolean): boolean {
  const result = db()
    .update(sources)
    .set({ archived_at: archived ? Date.now() : null })
    .where(eq(sources.id, id))
    .run();
  return result.changes > 0;
}

export interface SourceWithAggregates extends Source {
  iteration_count: number;
  favorite_count: number;
}

/**
 * Source strip data: active sources newest-first, with iteration + favorite counts.
 * Single query, no N+1.
 */
export function listActiveSourcesWithAggregates(
  limit = 20,
): SourceWithAggregates[] {
  const rows = db()
    .select({
      id: sources.id,
      input_image_key: sources.input_image_key,
      original_filename: sources.original_filename,
      w: sources.w,
      h: sources.h,
      aspect_ratio: sources.aspect_ratio,
      created_at: sources.created_at,
      archived_at: sources.archived_at,
      iteration_count: sql<number>`COUNT(DISTINCT ${iterations.id})`,
      favorite_count: sql<number>`COUNT(${tiles.id}) FILTER (WHERE ${tiles.is_favorite} = 1)`,
    })
    .from(sources)
    .leftJoin(iterations, eq(iterations.source_id, sources.id))
    .leftJoin(tiles, eq(tiles.iteration_id, iterations.id))
    .where(isNull(sources.archived_at))
    .groupBy(sources.id)
    .orderBy(desc(sources.created_at))
    .limit(limit)
    .all() as SourceWithAggregates[];
  return rows;
}

export function listAllSources(limit = 50): Source[] {
  return db()
    .select()
    .from(sources)
    .orderBy(desc(sources.created_at))
    .limit(limit)
    .all();
}

/**
 * Returns the full set of R2 keys associated with a source for the
 * "delete forever" cleanup path. Includes:
 *   - the source's own input image (`sources.input_image_key`),
 *   - every output / thumb key for tiles whose iterations belong to this
 *     source — INCLUDING soft-deleted tiles, since the R2 objects
 *     persist even after a soft delete (tile rows keep `deleted_at` but
 *     the underlying images stayed put).
 *
 * Callers pass the array to `deleteObjects()` before hard-deleting the
 * `sources` row. CASCADE handles the iterations + tiles row removal;
 * R2 cleanup is the only piece that needs explicit listing.
 */
export function listAllR2KeysForSource(sourceId: string): string[] {
  const src = getSource(sourceId);
  if (!src) return [];
  // Single join query: pull both columns from tiles for every iteration of
  // this source. Soft-deleted tiles included (we want the R2 objects gone
  // either way).
  const tileRows = db()
    .select({
      output_image_key: tiles.output_image_key,
      thumb_image_key: tiles.thumb_image_key,
    })
    .from(tiles)
    .innerJoin(iterations, eq(iterations.id, tiles.iteration_id))
    .where(eq(iterations.source_id, sourceId))
    .all();
  const keys: string[] = [src.input_image_key];
  for (const row of tileRows) {
    if (row.output_image_key) keys.push(row.output_image_key);
    if (row.thumb_image_key) keys.push(row.thumb_image_key);
  }
  return keys;
}

/**
 * Hard-delete a source row. Returns true if the row existed and was
 * removed. CASCADE on `iterations.source_id` removes all of this
 * source's iterations, which in turn cascades to `tiles.iteration_id`
 * for the tile rows. `usage_log.iteration_id` has no ON DELETE clause
 * (defaults to NO ACTION / restrict in SQLite), so callers must clear
 * the iteration_id FK on usage_log rows BEFORE calling this if any
 * usage_log rows reference iterations of this source — see
 * `nullifyUsageLogForSource`.
 *
 * Wrapped at the API layer in a transaction with the usage_log update +
 * R2 cleanup so the whole operation is atomic from the DB's perspective
 * (R2 is best-effort; orphan objects are recoverable).
 */
export function hardDeleteSource(id: string): boolean {
  const result = db().delete(sources).where(eq(sources.id, id)).run();
  return result.changes > 0;
}

/**
 * Set `usage_log.iteration_id = NULL` for every row whose iteration
 * belongs to this source. Preserves the cost record (cap math still
 * sees the spend) but breaks the FK link so iterations can be hard-
 * deleted. Called inside the source-hard-delete transaction.
 */
export function nullifyUsageLogForSource(sourceId: string): void {
  // SQLite update with subquery: we don't have a usage_log → source FK
  // directly; we need to find usage_log rows whose iteration_id matches
  // any iteration whose source_id matches.
  db().run(sql`
    UPDATE usage_log
       SET iteration_id = NULL
     WHERE iteration_id IN (
       SELECT id FROM iterations WHERE source_id = ${sourceId}
     )
  `);
}

// ---------- iterations ----------

export function findIterationByRequestId(
  requestId: string,
): Iteration | undefined {
  return db()
    .select()
    .from(iterations)
    .where(eq(iterations.request_id, requestId))
    .get();
}

export function getIteration(id: string): Iteration | undefined {
  return db().select().from(iterations).where(eq(iterations.id, id)).get();
}

/**
 * Atomically insert iteration + N pending tiles (N = `iteration.tile_count`). UNIQUE
 * on iterations.request_id is what makes idempotency safe: a concurrent retry hits the
 * unique violation and the caller falls back to `findIterationByRequestId`. The
 * caller is responsible for materialising `tileRows` with `idx` 0..N-1; this function
 * just persists them.
 */
export function insertIterationAndTiles(
  iteration: NewIteration,
  tileRows: NewTile[],
): void {
  db().transaction((tx) => {
    tx.insert(iterations).values(iteration).run();
    for (const t of tileRows) tx.insert(tiles).values(t).run();
  });
}

export function updateIterationStatus(
  id: string,
  status: Iteration["status"],
  completedAt?: number,
): void {
  db()
    .update(iterations)
    .set({ status, completed_at: completedAt ?? null })
    .where(eq(iterations.id, id))
    .run();
}

export function listIterations(opts: {
  limit?: number;
  before?: number;
  sourceId?: string;
}): Iteration[] {
  const limit = opts.limit ?? 50;
  const conds = [];
  if (typeof opts.before === "number")
    conds.push(lt(iterations.created_at, opts.before));
  if (opts.sourceId) conds.push(eq(iterations.source_id, opts.sourceId));
  let q = db().select().from(iterations).$dynamic();
  if (conds.length > 0) q = q.where(and(...conds));
  return q.orderBy(desc(iterations.created_at)).limit(limit).all();
}

/**
 * Iterations whose status is still `pending` or `running` — candidates for the
 * boot-time stuck-iteration recovery sweep. After a Railway redeploy mid-flight,
 * any in-process worker dies; the iteration's row remains pending forever
 * (the SSE stream and the optimistic UI both watch this column). Recovery
 * reconciles each one against R2: tiles whose output bytes ARE in R2 are
 * reconnected (status='done'); tiles without bytes are marked failed; the
 * iteration's rolled-up status is updated last.
 *
 * Does NOT filter by age — at boot time, every still-pending iteration from a
 * previous process is by definition orphaned (the worker that owned it is
 * gone). Caller (lib/stuckRecovery.ts) walks them serially.
 */
export function listStuckIterations(): Iteration[] {
  return db()
    .select()
    .from(iterations)
    .where(
      or(
        eq(iterations.status, "pending"),
        eq(iterations.status, "running"),
      ),
    )
    .all();
}

/**
 * R2 keys associated with one iteration — for the iteration-hard-delete
 * path (DELETE /api/iterations/:id). Returns every output_image_key and
 * thumb_image_key from `tiles` whose iteration_id matches, INCLUDING
 * soft-deleted tiles (their R2 objects survive soft delete and need
 * cleanup too).
 *
 * Mirror of `listAllR2KeysForSource` but scoped to one iteration. Caller
 * passes the array to `deleteObjects()` after the DB delete commits.
 */
export function listAllR2KeysForIteration(iterationId: string): string[] {
  const tileRows = db()
    .select({
      output_image_key: tiles.output_image_key,
      thumb_image_key: tiles.thumb_image_key,
    })
    .from(tiles)
    .where(eq(tiles.iteration_id, iterationId))
    .all();
  const keys: string[] = [];
  for (const row of tileRows) {
    if (row.output_image_key) keys.push(row.output_image_key);
    if (row.thumb_image_key) keys.push(row.thumb_image_key);
  }
  return keys;
}

/**
 * Mark any tile that's been `pending` for longer than `thresholdMs` as `failed`
 * with `error_message='server_restart'`. Called from instrumentation.ts at boot.
 *
 * Note: this is now a fallback. The primary boot-time recovery path is
 * `lib/stuckRecovery.ts recoverStuckIterations()` which checks R2 for
 * already-uploaded outputs and reconnects them where possible. This helper
 * stays in place as defense-in-depth for any tile the recovery missed
 * (e.g., R2 outage at boot caused all HEAD requests to fail).
 */
export function markStalePendingFailed(thresholdMs: number): number {
  const cutoff = Date.now() - thresholdMs;
  const result = db()
    .update(tiles)
    .set({
      status: "failed",
      error_message: "server_restart",
      completed_at: Date.now(),
    })
    .where(
      and(
        eq(tiles.status, "pending"),
        lt(tiles.created_at, cutoff),
      ),
    )
    .run();
  return result.changes;
}

/**
 * Sweep every pending tile of an iteration to `failed` with the given
 * error message. Used by worker hard-fail paths (source missing, blend
 * style missing, etc.) so the iteration row's terminal `'failed'`
 * status isn't paired with tile rows stuck in `'pending'` forever —
 * the UI would show an iteration that's officially failed but whose
 * tiles still pulse with the loading animation, looking permanently
 * broken. Returns the number of tile rows touched.
 *
 * Idempotent: tiles already in done/failed/blocked are left alone (the
 * `eq(tiles.status, "pending")` filter). Safe to call multiple times.
 */
export function failPendingTilesForIteration(
  iterationId: string,
  errorMessage: string,
): number {
  const now = Date.now();
  const result = db()
    .update(tiles)
    .set({
      status: "failed",
      error_message: errorMessage.slice(0, 500),
      completed_at: now,
    })
    .where(
      and(eq(tiles.iteration_id, iterationId), eq(tiles.status, "pending")),
    )
    .run();
  return result.changes;
}

// ---------- tiles ----------

/**
 * Active tiles for one iteration (excludes soft-deleted).
 *
 * `deleted_at IS NULL` filter is the default — soft-deleted tiles never
 * surface in the stream, the favorites view, or the lightbox. Use
 * `tilesForIncludingDeleted` (TODO: add when an admin / restore flow
 * exists) for the rare case where a soft-deleted tile is the target.
 */
export function tilesFor(iterationId: string): Tile[] {
  return db()
    .select()
    .from(tiles)
    .where(and(eq(tiles.iteration_id, iterationId), isNull(tiles.deleted_at)))
    .orderBy(tiles.idx)
    .all();
}

/**
 * Fetch active tiles for a batch of iteration ids in one query — used by the
 * iteration list endpoint so it can return iterations with embedded tiles
 * without an N+1 fetch. Empty input returns []. Returns rows in DB order; the
 * caller groups by `iteration_id` and orders by `idx` per iteration.
 *
 * Soft-deleted tiles are excluded.
 */
export function tilesForIterations(iterationIds: ReadonlyArray<string>): Tile[] {
  if (iterationIds.length === 0) return [];
  return db()
    .select()
    .from(tiles)
    .where(
      and(
        inArray(tiles.iteration_id, iterationIds as string[]),
        isNull(tiles.deleted_at),
      ),
    )
    .all();
}

/**
 * Get a single tile by id, INCLUDING soft-deleted (raw row read).
 *
 * Most call sites care about active tiles only — for those check
 * `tile.deleted_at === null` after the lookup. The image-bytes proxy and the
 * favorite-toggle path use this raw form because they need to detect a
 * just-deleted-by-another-tab race and 404 cleanly. The Lightbox view
 * reconciliation also reads raw to handle the in-flight delete case.
 */
export function getTile(tileId: string): Tile | undefined {
  return db().select().from(tiles).where(eq(tiles.id, tileId)).get();
}

/**
 * Soft-delete a tile by setting `deleted_at = now`. Returns true iff the row
 * existed AND was active (not already soft-deleted). Idempotent on
 * already-deleted rows: returns false without re-stamping the timestamp, so
 * callers can distinguish "did the work" from "no-op" if they care.
 */
export function softDeleteTile(tileId: string): boolean {
  const result = db()
    .update(tiles)
    .set({ deleted_at: Date.now() })
    .where(and(eq(tiles.id, tileId), isNull(tiles.deleted_at)))
    .run();
  return result.changes > 0;
}

/**
 * Count active tiles for an iteration. Used by the tile-delete API so it can
 * tell the client "this was the last tile — the iteration row is now empty"
 * (the client uses that signal to fade the iteration out of the stream).
 *
 * Soft-deleted tiles excluded by the WHERE clause; the active-only partial
 * index `idx_tiles_iter_active` covers this read.
 */
export function countActiveTilesForIteration(iterationId: string): number {
  const row = db()
    .select({ count: count(tiles.id) })
    .from(tiles)
    .where(
      and(
        eq(tiles.iteration_id, iterationId),
        isNull(tiles.deleted_at),
      ),
    )
    .get();
  return row?.count ?? 0;
}

/**
 * Set `usage_log.iteration_id = NULL` for rows referencing this single
 * iteration. Same rationale as `nullifyUsageLogForSource` but scoped to
 * one iteration — used by the empty-iteration cleanup path triggered
 * when a user soft-deletes the last active tile of an iteration.
 *
 * Preserves the cost record (cap math still sees the spend) while
 * breaking the FK link so the iteration row can be hard-deleted.
 */
export function nullifyUsageLogForIteration(iterationId: string): void {
  db()
    .update(usage_log)
    .set({ iteration_id: null })
    .where(eq(usage_log.iteration_id, iterationId))
    .run();
}

/**
 * Hard-delete an iteration row. Returns true iff the row existed.
 * CASCADE on `tiles.iteration_id` removes the corresponding tile rows
 * (including soft-deleted ones — the FK doesn't care about deleted_at).
 *
 * Caller must have already cleared any usage_log references via
 * `nullifyUsageLogForIteration` — the FK has no ON DELETE clause so
 * leaving usage_log rows pointing at this iteration would fail the
 * delete (RESTRICT is the SQLite default).
 *
 * Used by the empty-iteration cleanup path; wrapped at the API layer
 * in a transaction with the usage_log nullify so the whole operation
 * is atomic.
 */
export function hardDeleteIteration(iterationId: string): boolean {
  const result = db()
    .delete(iterations)
    .where(eq(iterations.id, iterationId))
    .run();
  return result.changes > 0;
}

/**
 * Boot-sweep cleanup: hard-delete every iteration row that has zero
 * active tiles. Used by `instrumentation.ts` to reap legacy empty
 * iterations on each deploy — handles iterations whose every tile was
 * soft-deleted before the per-delete cleanup path existed (the
 * /api/tiles/:id route's transaction adds the cleanup going forward,
 * but pre-existing all-deleted iterations would otherwise linger).
 *
 * Excludes iterations whose status is still `pending` or `running` —
 * those may be mid-stream from a worker that hasn't materialized any
 * tile rows yet (rare race, but real). Only sweep `done` and `failed`
 * iterations.
 *
 * Returns the number of iterations reaped. Wrapped in a single
 * transaction so the whole sweep is atomic.
 */
export function cleanupEmptyIterations(): number {
  // Find iteration ids that have zero active tiles AND are in a
  // terminal status. Subquery: NOT EXISTS (SELECT 1 FROM tiles WHERE
  // iteration_id = ? AND deleted_at IS NULL).
  const empties = db()
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        or(eq(iterations.status, "done"), eq(iterations.status, "failed")),
        sql`NOT EXISTS (
          SELECT 1 FROM ${tiles}
           WHERE ${tiles.iteration_id} = ${iterations.id}
             AND ${tiles.deleted_at} IS NULL
        )`,
      ),
    )
    .all();
  if (empties.length === 0) return 0;
  const ids = empties.map((e) => e.id);
  let count = 0;
  db().transaction((tx) => {
    // Nullify usage_log refs first (RESTRICT default would block the
    // DELETE otherwise — same rationale as the per-iteration cleanup
    // helper).
    tx.update(usage_log)
      .set({ iteration_id: null })
      .where(inArray(usage_log.iteration_id, ids))
      .run();
    // Nullify any iteration's parent_tile_id that points to a tile
    // belonging to any of the iterations we're about to delete. v2
    // added `iterations.parent_tile_id` via ALTER TABLE ADD COLUMN
    // (no enforced ON DELETE), so without this nullify the cascade-
    // delete of these iterations' tiles would leave dangling
    // provenance pointers on spawned iterations. Same RESTRICT-default
    // issue as usage_log. See migration 0006 header.
    //
    // Two-step: enumerate the tile ids first (the drizzle sql template
    // doesn't bind a JS array to an IN clause cleanly), then update via
    // the structured builder using `inArray`. Skip the UPDATE if there
    // are no tiles to orphan.
    const tileIds = tx
      .select({ id: tiles.id })
      .from(tiles)
      .where(inArray(tiles.iteration_id, ids))
      .all()
      .map((r) => r.id);
    if (tileIds.length > 0) {
      tx.update(iterations)
        .set({ parent_tile_id: null })
        .where(inArray(iterations.parent_tile_id, tileIds))
        .run();
    }
    // Hard-delete the iterations. CASCADE removes the tile rows
    // (including soft-deleted ones — they were already excluded from
    // read paths via deleted_at IS NOT NULL).
    const result = tx
      .delete(iterations)
      .where(inArray(iterations.id, ids))
      .run();
    count = result.changes;
  });
  return count;
}

export function updateTile(
  iterationId: string,
  idx: number,
  patch: Partial<Tile>,
): void {
  db()
    .update(tiles)
    .set(patch)
    .where(and(eq(tiles.iteration_id, iterationId), eq(tiles.idx, idx)))
    .run();
}

export function setFavorite(
  tileId: string,
  favorite: boolean,
): { tile_id: string; is_favorite: number; favorited_at: number | null } | null {
  const now = Date.now();
  db()
    .update(tiles)
    .set({
      is_favorite: favorite ? 1 : 0,
      favorited_at: favorite ? now : null,
    })
    .where(eq(tiles.id, tileId))
    .run();
  const row = db()
    .select({
      tile_id: tiles.id,
      is_favorite: tiles.is_favorite,
      favorited_at: tiles.favorited_at,
    })
    .from(tiles)
    .where(eq(tiles.id, tileId))
    .get();
  return row ?? null;
}

export interface FavoriteRow {
  tile_id: string;
  source_id: string;
  source_archived: boolean;
  source_aspect_ratio: string;
  /** From `sources.input_image_key`. The original painting's R2 key.
   *  Threaded through to the cross-source Lightbox snapshot so the
   *  Compare-with-Original mode can render the source alongside the
   *  generated tile without an extra /api/sources/:id roundtrip. */
  source_input_key: string;
  iteration_id: string;
  idx: number;
  output_image_key: string | null;
  thumb_image_key: string | null;
  favorited_at: number;
  created_at: number;
  model_tier: "flash" | "pro";
  resolution: "1k" | "4k";
  /** From `iterations.aspect_ratio_mode`. Combine with `source_aspect_ratio`
   *  to get the tile's effective aspect: `mode === 'flip' ? flip(src) : src`.
   *  Clients that render the tile (FavoritesPanel thumbnail container,
   *  Lightbox snapshot) need this to size the container correctly when the
   *  tile was generated with flip mode. */
  aspect_ratio_mode: "match" | "flip";
  /** v2.4: per-tile style attribution. Threaded through so the cross-
   *  source Lightbox snapshot can swap its toolbar to "Iterate on this
   *  direction" + Compare-with-style for favorited style_explore tiles
   *  (and favorited prompt-mode tiles spawned via the handoff). NULL
   *  for plain prompt-mode tiles. */
  style_painting_id: string | null;
  /** v3.1: iteration mode this tile belongs to. Needed by the
   *  Lightbox snapshot path to detect blend tiles (style_blend) and
   *  hide Compare — blend doesn't use the source as input so a
   *  before/after pair would render a misleading transform
   *  relationship. */
  mode: "prompt" | "style_explore" | "style_blend";
}

/**
 * Cross-source favorites: tiles → iterations → sources join. Returns favorited tiles
 * across ALL sources (active + archived) sorted by favorited_at DESC. Cursor pagination
 * via `before` (favorited_at).
 */
export function listFavorites(opts: {
  limit?: number;
  before?: number;
}): FavoriteRow[] {
  const limit = opts.limit ?? 50;
  // Soft-deleted tiles are excluded from the favorites view — delete trumps
  // favorite. The new partial index `idx_tiles_fav` covers this filter
  // directly so the query stays a single index scan.
  const conds = [eq(tiles.is_favorite, 1), isNull(tiles.deleted_at)];
  if (typeof opts.before === "number") {
    conds.push(lt(tiles.favorited_at, opts.before));
  }
  const rows = db()
    .select({
      tile_id: tiles.id,
      source_id: sources.id,
      source_archived: sql<boolean>`${sources.archived_at} IS NOT NULL`,
      source_aspect_ratio: sources.aspect_ratio,
      source_input_key: sources.input_image_key,
      iteration_id: iterations.id,
      idx: tiles.idx,
      output_image_key: tiles.output_image_key,
      thumb_image_key: tiles.thumb_image_key,
      favorited_at: tiles.favorited_at,
      created_at: tiles.created_at,
      model_tier: iterations.model_tier,
      resolution: iterations.resolution,
      aspect_ratio_mode: iterations.aspect_ratio_mode,
      style_painting_id: tiles.style_painting_id,
      mode: iterations.mode,
    })
    .from(tiles)
    .innerJoin(iterations, eq(iterations.id, tiles.iteration_id))
    .innerJoin(sources, eq(sources.id, iterations.source_id))
    .where(and(...conds))
    .orderBy(desc(tiles.favorited_at))
    .limit(limit)
    .all() as FavoriteRow[];
  return rows;
}

// ---------- style_paintings ----------

export function insertStylePainting(row: NewStylePainting): void {
  db().insert(style_paintings).values(row).run();
}

export function getStylePainting(id: string): StylePainting | undefined {
  return db()
    .select()
    .from(style_paintings)
    .where(eq(style_paintings.id, id))
    .get();
}

/**
 * List style paintings newest-first. v2.1 ships with a single flat list —
 * the ExploreSheet client-side shuffles its own copy for variety. `archived`
 * defaults to false (mirrors `listActiveSourcesWithAggregates`); pass `true`
 * for the deferred Archived Styles drawer once that lands.
 */
export function listStylePaintings(opts: {
  archived?: boolean;
  limit?: number;
}): StylePainting[] {
  const limit = opts.limit ?? 200;
  const archived = opts.archived ?? false;
  return db()
    .select()
    .from(style_paintings)
    .where(
      archived
        ? sql`${style_paintings.archived_at} IS NOT NULL`
        : isNull(style_paintings.archived_at),
    )
    .orderBy(desc(style_paintings.created_at))
    .limit(limit)
    .all();
}

export function setStylePaintingArchived(
  id: string,
  archived: boolean,
): boolean {
  const result = db()
    .update(style_paintings)
    .set({ archived_at: archived ? Date.now() : null })
    .where(eq(style_paintings.id, id))
    .run();
  return result.changes > 0;
}

/**
 * Partial update of editable metadata (title / artist / note / tag). v2.1
 * doesn't surface an edit UI yet (deferred to v0.2 per the plan) but the
 * helper exists so the same PATCH route handles archive toggle + future
 * metadata edits without re-plumbing. Pass only the fields you want to
 * change; unset keys leave the row untouched.
 */
export function updateStylePaintingMetadata(
  id: string,
  patch: Partial<Pick<StylePainting, "title" | "artist" | "note" | "tag">>,
): boolean {
  if (Object.keys(patch).length === 0) return false;
  const result = db()
    .update(style_paintings)
    .set(patch)
    .where(eq(style_paintings.id, id))
    .run();
  return result.changes > 0;
}

/**
 * R2 keys associated with a style painting for the hard-delete path. v2.1
 * stores ONE image per style painting (`styles/<id>.jpg`) — there are no
 * derived thumbs at the moment (the StylesPanel renders the same key
 * through `<ImageBytes>` which produces sized variants client-side via the
 * existing image-bytes proxy). Returns a single-element array for shape
 * parity with `listAllR2KeysForSource` so the caller can hand it straight
 * to `deleteObjects()`.
 */
export function listAllR2KeysForStylePainting(id: string): string[] {
  const sp = getStylePainting(id);
  return sp ? [sp.input_image_key] : [];
}

/**
 * Set `tiles.style_painting_id = NULL` for every tile referencing this
 * style painting. Required BEFORE `hardDeleteStylePainting` because the FK
 * was added via `ALTER TABLE ADD COLUMN` and SQLite does NOT enforce ON
 * DELETE SET NULL clauses on FKs added that way (drizzle-kit drops the
 * clause from the generated SQL for that reason — see migration 0006's
 * header). Without this nullify, the FK's default NO ACTION would block
 * the parent delete with FOREIGN KEY constraint failed.
 *
 * Same pattern as `nullifyUsageLogForSource` for the equally-weak
 * `usage_log.iteration_id` FK. Caller wraps both ops in a transaction.
 */
export function nullifyTilesForStylePainting(id: string): number {
  const result = db()
    .update(tiles)
    .set({ style_painting_id: null })
    .where(eq(tiles.style_painting_id, id))
    .run();
  return result.changes;
}

/**
 * Hard-delete a style_painting row. Returns true iff the row existed.
 * Caller MUST have already called `nullifyTilesForStylePainting` (see
 * the rationale on that helper). Wrapped at the API layer in a single
 * transaction with the nullify + R2 cleanup so the operation is atomic
 * from the DB's perspective.
 *
 * Referenced tiles + iterations persist after the delete; only the
 * attribution link disappears. The StyleAttributionThumb renders an
 * "unavailable" placeholder for tiles whose style_painting_id is NULL.
 */
export function hardDeleteStylePainting(id: string): boolean {
  const result = db()
    .delete(style_paintings)
    .where(eq(style_paintings.id, id))
    .run();
  return result.changes > 0;
}

// ---------- parent_tile_id nullify helpers (v2.1) ----------

/**
 * Set `iterations.parent_tile_id = NULL` for every iteration referencing
 * any of the provided tile ids. Required by every hard-delete path that
 * removes tiles (single-tile delete, iteration cascade, source cascade,
 * empty-iteration sweep) because the FK was added via ALTER TABLE ADD
 * COLUMN — SQLite's default NO ACTION blocks the delete otherwise.
 *
 * Empty input is a no-op (returns 0). Caller wraps in a transaction.
 *
 * See `nullifyTilesForStylePainting` for the broader rationale on
 * weak-FK manual nullification.
 */
export function nullifyParentTileForTileIds(
  tileIds: ReadonlyArray<string>,
): number {
  if (tileIds.length === 0) return 0;
  const result = db()
    .update(iterations)
    .set({ parent_tile_id: null })
    .where(inArray(iterations.parent_tile_id, tileIds as string[]))
    .run();
  return result.changes;
}

/**
 * Nullify any iteration's parent_tile_id that points to a tile belonging
 * to the given iteration. Used by `hardDeleteIteration`'s caller before
 * the cascade-delete fires, so the "Iterate on this direction" provenance
 * link on spawned iterations turns into NULL instead of dangling.
 */
export function nullifyParentTileForIteration(iterationId: string): number {
  const result = db().run(sql`
    UPDATE iterations
       SET parent_tile_id = NULL
     WHERE parent_tile_id IN (
       SELECT id FROM ${tiles} WHERE iteration_id = ${iterationId}
     )
  `);
  return result.changes;
}

/**
 * Nullify any iteration's parent_tile_id that points to a tile belonging
 * to any iteration of the given source. Used by `hardDeleteSource`'s
 * caller before the cascade-delete fires across iterations + tiles.
 * Same rationale as `nullifyParentTileForIteration` but one join-level up.
 */
export function nullifyParentTileForSource(sourceId: string): number {
  const result = db().run(sql`
    UPDATE iterations
       SET parent_tile_id = NULL
     WHERE parent_tile_id IN (
       SELECT t.id
         FROM ${tiles} AS t
         JOIN ${iterations} AS i ON i.id = t.iteration_id
        WHERE i.source_id = ${sourceId}
     )
  `);
  return result.changes;
}

// ---------- usage_log ----------

export function insertUsageLog(
  iterationId: string,
  costUsd: number,
  /** v5.3: engine tier + completed-call count for the daily quota
   *  gauge. See the usage_log schema comment — these survive
   *  iteration hard-deletes, unlike tile rows. */
  modelTier: "flash" | "pro" | "flux" | "flux2max" | "seedream",
  imageCount: number,
): void {
  db()
    .insert(usage_log)
    .values({
      iteration_id: iterationId,
      cost_usd: costUsd,
      model_tier: modelTier,
      image_count: imageCount,
      created_at: Date.now(),
    })
    .run();
}

/** Sum of cost_usd for the current calendar month (UTC). */
export function monthlyUsageUsd(): number {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const row = db()
    .select({ total: sql<number>`COALESCE(SUM(${usage_log.cost_usd}), 0)` })
    .from(usage_log)
    .where(gte(usage_log.created_at, monthStart))
    .get();
  return row?.total ?? 0;
}

/**
 * v5.3: approximate count of Gemini PRO image requests fired since
 * `sinceMs` — the fuel gauge against Google's per-model DAILY request
 * quota (250/day on the current tier; resets ~midnight UTC, observed
 * July 3 2026).
 *
 * Counted as tiles on model_tier='pro' iterations whose status is
 * 'done' or 'blocked' (both consumed a completed Gemini call). 'failed'
 * tiles are EXCLUDED: on a quota day the dominant failure is the 429
 * itself, which Google rejects without consuming quota — counting
 * those would run the gauge to the cap while actual quota remained.
 * Retry attempts inside callWithRetry aren't logged anywhere, so the
 * count can UNDERSTATE true consumption slightly — surface it with a
 * "~" in the UI, never as an exact promise.
 */
export function proRequestsSince(sinceMs: number): number {
  const row = db()
    .select({ total: sql<number>`COUNT(*)` })
    .from(tiles)
    .innerJoin(iterations, eq(tiles.iteration_id, iterations.id))
    .where(
      and(
        eq(iterations.model_tier, "pro"),
        gte(tiles.created_at, sinceMs),
        inArray(tiles.status, ["done", "blocked"]),
      ),
    )
    .get();
  return row?.total ?? 0;
}

/**
 * v5.3 (migration 0010): delete-proof Pro request count — sums the
 * per-iteration image_count recorded in usage_log at completion.
 * usage_log rows survive iteration hard-deletes (iteration_id is
 * nullified, the row stays), so this doesn't shrink when Zuzi prunes
 * runs. The /api/usage gauge takes MAX(this, proRequestsSince): the
 * tile-based count covers in-flight iterations (logged only at
 * completion) + pre-0010 data; this one covers deleted history.
 */
export function proImagesLoggedSince(sinceMs: number): number {
  const row = db()
    .select({
      total: sql<number>`COALESCE(SUM(${usage_log.image_count}), 0)`,
    })
    .from(usage_log)
    .where(
      and(
        eq(usage_log.model_tier, "pro"),
        gte(usage_log.created_at, sinceMs),
      ),
    )
    .get();
  return row?.total ?? 0;
}
