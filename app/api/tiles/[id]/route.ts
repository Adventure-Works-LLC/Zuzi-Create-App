/**
 * DELETE /api/tiles/:id — soft-delete a tile.
 *
 * Sets `tiles.deleted_at = now` so all read paths (stream, favorites,
 * lightbox) drop the tile immediately. Idempotent: re-deleting a row that's
 * already soft-deleted returns 200 with `{ alreadyDeleted: true }` instead
 * of failing.
 *
 * Returns:
 *   {
 *     id: string,                   // the tile id
 *     iterationId: string,          // for the client to update store state
 *     activeTileCountForIteration: number  // 0 means the iteration's stream
 *                                          // row should fade out next
 *   }
 *
 * Tiles are cheap to regenerate (re-Generate with the same presets) so this
 * is one-tier — there's no user-facing recovery flow. The `deleted_at`
 * column exists primarily so we don't have to reckon with FK-cascade
 * implications of a hard delete on a still-referenced row, AND so a future
 * periodic cleanup job can sweep aging soft-deleted tiles + their R2 keys.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  countActiveTilesForIteration,
  getTile,
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

  const didChange = softDeleteTile(id);
  // Recompute the active-tile count AFTER the delete so the client knows if
  // this was the last tile of its iteration. If it was, the client fades the
  // iteration's row out of the stream (the iteration row itself stays in DB
  // for backup / debugging; a future cleanup job can hard-delete iterations
  // whose tile count has been zero for >N days).
  const activeTileCountForIteration = countActiveTilesForIteration(
    tile.iteration_id,
  );

  return NextResponse.json(
    {
      id,
      iterationId: tile.iteration_id,
      activeTileCountForIteration,
      alreadyDeleted: !didChange,
    },
    { status: 200 },
  );
}
