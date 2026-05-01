/**
 * PATCH /api/sources/:id — body {archived: boolean}. Toggles sources.archived_at.
 *
 * DELETE /api/sources/:id?permanent=true — hard-delete a source row, its
 * iterations (CASCADE), its tiles (CASCADE), and the corresponding R2
 * objects (input image + every output image + every thumb). Requires the
 * `?permanent=true` query parameter as a defensive guard — without it, the
 * route returns 400 to make the destructive intent explicit at the URL
 * level. The user-facing UX layer is responsible for the confirmation
 * dialog (per the same pattern as tile delete).
 *
 * Hard-delete is the "I never want to see this again" tier; archive (via
 * PATCH above) is the "I'm done with this for now" tier. The two coexist
 * — Zuzi reaches archive via long-press → ActionMenu → "Archive", and
 * delete via the same menu's "Delete Forever" option (with confirm).
 *
 * `usage_log.iteration_id` has no `ON DELETE` clause (defaults to RESTRICT
 * in SQLite), so we nullify those references before deleting the source.
 * The cost record itself is preserved — the monthly cap math reads the
 * sum of `cost_usd` regardless of iteration_id, so nullifying doesn't
 * leak budget. See `nullifyUsageLogForSource` in lib/db/queries.ts.
 *
 * R2 cleanup is best-effort: orphan objects don't break correctness (the
 * DB row is gone, so no UI surface points at them) and a future sweep
 * job can reap them. The DB delete inside the transaction is the
 * load-bearing operation.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3 + AWS SDK.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import {
  hardDeleteSource,
  listAllR2KeysForSource,
  nullifyUsageLogForSource,
  setSourceArchived,
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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let body: { archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.archived !== "boolean") {
    return NextResponse.json(
      { error: "invalid_archived_field" },
      { status: 400 },
    );
  }

  const ok = setSourceArchived(id, body.archived);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { id, archived: body.archived },
    { status: 200 },
  );
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  // Defensive: refuse to hard-delete unless the caller passes
  // `?permanent=true`. Stops accidental DELETEs from typo'd URLs (and
  // makes the intent explicit when reading server logs after the fact).
  const url = new URL(req.url);
  if (url.searchParams.get("permanent") !== "true") {
    return NextResponse.json(
      {
        error: "permanent_flag_required",
        detail:
          "Hard delete requires ?permanent=true. To archive instead, PATCH with {archived:true}.",
      },
      { status: 400 },
    );
  }

  // Collect R2 keys BEFORE the DB transaction — once the rows are gone we
  // can't enumerate them. R2 cleanup runs AFTER the transaction succeeds
  // (so a DB failure doesn't leave us with a partial R2 wipe + intact
  // rows pointing at them). Keys are already prefix-validated by virtue
  // of being keys we ourselves wrote at upload / generation time.
  const r2Keys = listAllR2KeysForSource(id);
  if (r2Keys.length === 0) {
    // listAllR2KeysForSource returns [] iff the source row doesn't exist
    // — match the PATCH route's 404 shape so the client treats both
    // not-found cases identically.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Atomic DB delete: nullify usage_log refs (preserves cost record) →
  // hard-delete sources row (CASCADE removes iterations + tiles).
  // Wrapped in a transaction so a partial failure rolls back cleanly.
  let dbDeleted = false;
  try {
    db().transaction(() => {
      nullifyUsageLogForSource(id);
      dbDeleted = hardDeleteSource(id);
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
    // Race: source vanished between key enumeration and the DELETE
    // (concurrent request also deleting). Treat as 404 — the caller
    // wanted it gone, it's gone.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Best-effort R2 cleanup. Failures here don't roll back the DB delete;
  // log + continue. The user-facing "delete forever" promise is about
  // the row leaving the UI, not perfect storage hygiene. A future sweep
  // job can reap orphans by scanning R2 for keys with no DB referent.
  try {
    await deleteObjects(r2Keys);
  } catch (e) {
    console.warn(
      `[sources DELETE] R2 cleanup failed for source ${id} (${r2Keys.length} keys); DB row already removed`,
      e instanceof Error ? e.message : String(e),
    );
  }

  return NextResponse.json(
    { id, deleted: true, r2KeysDeleted: r2Keys.length },
    { status: 200 },
  );
}
