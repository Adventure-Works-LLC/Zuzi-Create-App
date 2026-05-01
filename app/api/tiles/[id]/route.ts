/**
 * DELETE /api/tiles/:id — soft-delete a tile, with empty-iteration cleanup.
 *
 * Sets `tiles.deleted_at = now` so all read paths (stream, favorites,
 * lightbox) drop the tile immediately. Idempotent: re-deleting a row that's
 * already soft-deleted returns 200 with `{ alreadyDeleted: true }` instead
 * of failing.
 *
 * EMPTY ITERATION CLEANUP: After the soft-delete lands, if the iteration
 * has zero remaining active tiles, hard-delete the iteration row in the
 * SAME transaction. CASCADE on `tiles.iteration_id` removes the soft-
 * deleted tile rows. `usage_log.iteration_id` is nullified first (the FK
 * has no ON DELETE clause; preserves the cost record, breaks the link).
 * This prevents orphan iteration rows from accumulating in the DB once
 * a user has deleted every tile of an iteration.
 *
 * Returns:
 *   {
 *     id: string,                   // the tile id
 *     iterationId: string,          // for the client to update store state
 *     activeTileCountForIteration: number  // 0 means the iteration was
 *                                          // hard-deleted in this request
 *     iterationDeleted: boolean,    // true iff cleanup ran
 *     alreadyDeleted: boolean,
 *   }
 *
 * Tiles are cheap to regenerate (re-Generate with the same presets) so this
 * is one-tier — there's no user-facing recovery flow. The `deleted_at`
 * column on tiles still exists for the in-flight delete window: between
 * soft-delete and the (possibly never-firing) iteration cleanup, the tile
 * is `deleted_at IS NOT NULL` and excluded from read paths via the
 * existing partial indexes.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import {
  countActiveTilesForIteration,
  getTile,
  hardDeleteIteration,
  nullifyUsageLogForIteration,
  softDeleteTile,
} from "@/lib/db/queries";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  // Look up before delete so we can return iterationId regardless of whether
  // the delete actually changed any rows (idempotent path) and so we can
  // distinguish 404 from already-deleted.
  const tile = getTile(id);
  if (!tile) {
    return NextResponse.json(
      { error: "tile_not_found", detail: `no tile with id ${id}` },
      { status: 404 },
    );
  }

  // Optimistic-id guard: tiles whose ids start with "opt-" are client-only
  // optimistic placeholders that don't exist in DB. They shouldn't reach
  // this route — the Tile UI gates on this prefix — but defense in depth.
  if (id.startsWith("opt-")) {
    return NextResponse.json(
      { error: "optimistic_tile_not_persisted" },
      { status: 400 },
    );
  }

  // Atomic block: soft-delete the tile, count remaining active tiles, and
  // (if zero) hard-delete the iteration row + nullify usage_log refs in
  // ONE transaction. Either the delete succeeds end-to-end or it rolls
  // back — no half-deleted iteration with stale usage_log references.
  let didChange = false;
  let activeTileCountForIteration = 0;
  let iterationDeleted = false;
  try {
    db().transaction(() => {
      didChange = softDeleteTile(id);
      activeTileCountForIteration = countActiveTilesForIteration(
        tile.iteration_id,
      );
      if (activeTileCountForIteration === 0) {
        // Zero active tiles remain — clean up the now-empty iteration row.
        // Order matters: nullify usage_log FK first (RESTRICT default
        // would otherwise block the DELETE), then hard-delete the
        // iteration (CASCADE removes the soft-deleted tile rows).
        nullifyUsageLogForIteration(tile.iteration_id);
        iterationDeleted = hardDeleteIteration(tile.iteration_id);
      }
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "delete_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      id,
      iterationId: tile.iteration_id,
      activeTileCountForIteration,
      iterationDeleted,
      alreadyDeleted: !didChange,
    },
    { status: 200 },
  );
}
