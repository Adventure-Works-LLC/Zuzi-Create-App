/**
 * Typed query helpers. Every code path that reads or writes the DB goes through here —
 * keeps Drizzle queries in one place and gives a stable seam for tests.
 *
 * Conventions:
 *   - All timestamps are unix ms.
 *   - All ids are ulids (text).
 *   - Functions return plain rows / row arrays; callers shape the response.
 */

import { and, count, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

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
 * Atomically insert iteration + 9 pending tiles. UNIQUE on iterations.request_id is
 * what makes idempotency safe: a concurrent retry hits the unique violation and the
 * caller falls back to `findIterationByRequestId`.
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

export function tilesFor(iterationId: string): Tile[] {
  return db()
    .select()
    .from(tiles)
    .where(eq(tiles.iteration_id, iterationId))
    .orderBy(tiles.idx)
    .all();
}

export function getTile(tileId: string): Tile | undefined {
  return db().select().from(tiles).where(eq(tiles.id, tileId)).get();
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
  iteration_id: string;
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
  const conds = [eq(tiles.is_favorite, 1)];
  if (typeof opts.before === "number") {
    conds.push(lt(tiles.favorited_at, opts.before));
  }
  const rows = db()
    .select({
      tile_id: tiles.id,
      source_id: sources.id,
      source_archived: sql<boolean>`${sources.archived_at} IS NOT NULL`,
      iteration_id: iterations.id,
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
