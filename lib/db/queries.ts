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
  tiles,
  usage_log,
  type Iteration,
  type NewIteration,
  type NewSource,
  type NewTile,
  type Source,
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
 * Mark any tile that's been `pending` for longer than `thresholdMs` as `failed`
 * with `error_message='server_restart'`. Called from instrumentation.ts at boot.
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
  iteration_id: string;
  idx: number;
  output_image_key: string | null;
  thumb_image_key: string | null;
  favorited_at: number;
  created_at: number;
  model_tier: "flash" | "pro";
  resolution: "1k" | "4k";
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
      iteration_id: iterations.id,
      idx: tiles.idx,
      output_image_key: tiles.output_image_key,
      thumb_image_key: tiles.thumb_image_key,
      favorited_at: tiles.favorited_at,
      created_at: tiles.created_at,
      model_tier: iterations.model_tier,
      resolution: iterations.resolution,
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

// ---------- usage_log ----------

export function insertUsageLog(
  iterationId: string,
  costUsd: number,
): void {
  db()
    .insert(usage_log)
    .values({
      iteration_id: iterationId,
      cost_usd: costUsd,
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
