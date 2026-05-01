/**
 * DELETE /api/iterations/:id — hard-delete an iteration row + every
 * tile (CASCADE) + best-effort R2 cleanup.
 *
 * The user-facing escape hatch from a stuck-pending iteration: even if
 * recovery couldn't bring an iteration back to a terminal state, this
 * route ALWAYS works. No status guard — pending, running, done,
 * failed, all delete the same way. Accepts iterations whose tiles are
 * any mix of statuses (including pending tiles that have no R2
 * objects yet — `deleteObjects` is idempotent on missing keys, so the
 * cleanup pass succeeds either way).
 *
 * Sequence:
 *   1. enumerate every R2 key on this iteration's tiles (output_image_key
 *      + thumb_image_key, INCLUDING soft-deleted tiles since their
 *      objects survive soft delete)
 *   2. transaction: nullifyUsageLogForIteration → hardDeleteIteration
 *      (CASCADE removes tile rows)
 *   3. deleteObjects(keys) best-effort
 *   4. return { id, deleted: true, r2KeysDeleted: N }
 *
 * Idempotency: re-deleting a missing iteration returns 404. Re-deleting
 * a missing R2 key inside step 3 succeeds silently (S3 DeleteObjects
 * semantics).
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3 + AWS SDK.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import {
  getIteration,
  hardDeleteIteration,
  listAllR2KeysForIteration,
  nullifyUsageLogForIteration,
} from "@/lib/db/queries";
import { deleteObjects } from "@/lib/storage/r2";

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

  // Existence check up front so we can return a clean 404 (vs the
  // ambiguous "0 rows changed" from hardDeleteIteration). Also lets us
  // skip the R2 enumeration when the row is already gone.
  const iter = getIteration(id);
  if (!iter) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Enumerate R2 keys BEFORE the DB delete so we can clean them up
  // after CASCADE removes the tile rows. Returns [] iff the iteration
  // had no tiles or all tiles had null keys (rare — pending tiles
  // with no R2 uploads yet).
  const r2Keys = listAllR2KeysForIteration(id);

  let dbDeleted = false;
  try {
    db().transaction(() => {
      // FK has no ON DELETE clause; nullify the link in usage_log so
      // the iteration delete can succeed (RESTRICT default would
      // otherwise block).
      nullifyUsageLogForIteration(id);
      dbDeleted = hardDeleteIteration(id);
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

  if (!dbDeleted) {
    // Race: iteration vanished between the existence check and the
    // DELETE (concurrent request also deleting). Treat as 404.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Best-effort R2 cleanup. Failures here don't roll back the DB
  // delete; log + continue. Orphan R2 objects don't break correctness
  // (no DB row points at them) and a future sweep job can reap them.
  if (r2Keys.length > 0) {
    try {
      await deleteObjects(r2Keys);
    } catch (e) {
      console.warn(
        `[iterations DELETE] R2 cleanup failed for iteration ${id} (${r2Keys.length} keys); DB row already removed`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return NextResponse.json(
    { id, deleted: true, r2KeysDeleted: r2Keys.length },
    { status: 200 },
  );
}
