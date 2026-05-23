/**
 * PATCH /api/style-paintings/:id — body shape `{ archived?: boolean, title?,
 * artist?, note?, tag?: string | null }`. At least one field must be
 * present. `archived` toggles `archived_at`; the metadata fields update
 * `style_paintings.{title,artist,note,tag}` (each is nullable —
 * passing `null` clears the column). v2.1 only surfaces the archive
 * toggle in UI (Per the plan, edit UI deferred to v0.2); the metadata
 * branch ships now so the same route handles both cases once the edit
 * dialog lands.
 *
 * DELETE /api/style-paintings/:id?permanent=true — hard-delete a style
 * painting + the corresponding R2 object. Requires the
 * `?permanent=true` query parameter as a defensive guard (same pattern
 * as `/api/sources/:id`). Referenced tiles persist after the delete;
 * only their `style_painting_id` attribution link nulls — see the
 * `nullifyTilesForStylePainting` note in lib/db/queries.ts on why the
 * pre-delete nullify is required (SQLite ALTER ADD COLUMN doesn't
 * enforce ON DELETE SET NULL).
 *
 * Auth required on both paths. runtime = 'nodejs' for better-sqlite3 +
 * AWS SDK.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { db } from "@/lib/db/client";
import {
  getStylePainting,
  hardDeleteStylePainting,
  listAllR2KeysForStylePainting,
  nullifyTilesForStylePainting,
  setStylePaintingArchived,
  updateStylePaintingMetadata,
} from "@/lib/db/queries";
import { deleteObjects } from "@/lib/storage/r2";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let body: {
    archived?: unknown;
    title?: unknown;
    artist?: unknown;
    note?: unknown;
    tag?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Build the metadata patch from any string-or-null fields the caller
  // sent. `undefined` (key not in body) means "don't touch"; explicit
  // `null` means "clear it". Anything else of the wrong type is a 400.
  const metadataPatch: Partial<{
    title: string | null;
    artist: string | null;
    note: string | null;
    tag: string | null;
  }> = {};
  for (const key of ["title", "artist", "note", "tag"] as const) {
    if (key in body) {
      const v = body[key];
      if (v === null || typeof v === "string") {
        metadataPatch[key] = v;
      } else {
        return NextResponse.json(
          { error: "invalid_metadata_field", field: key },
          { status: 400 },
        );
      }
    }
  }

  let didArchive = false;
  let didMetadata = false;
  let archivedValue: boolean | undefined;

  if ("archived" in body) {
    if (typeof body.archived !== "boolean") {
      return NextResponse.json(
        { error: "invalid_archived_field" },
        { status: 400 },
      );
    }
    archivedValue = body.archived;
    didArchive = setStylePaintingArchived(id, body.archived);
  }

  if (Object.keys(metadataPatch).length > 0) {
    didMetadata = updateStylePaintingMetadata(id, metadataPatch);
  }

  if (!("archived" in body) && Object.keys(metadataPatch).length === 0) {
    return NextResponse.json(
      {
        error: "no_fields",
        detail: "expected at least one of: archived, title, artist, note, tag",
      },
      { status: 400 },
    );
  }

  if (!didArchive && !didMetadata) {
    // Row didn't exist (neither helper found a row to change). Match
    // the sources route's 404 shape.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      id,
      archived: archivedValue ?? null,
      updated: { archived: didArchive, metadata: didMetadata },
    },
    { status: 200 },
  );
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  // Defensive: refuse to hard-delete unless the caller passes
  // `?permanent=true`. Stops accidental DELETEs from typo'd URLs (and
  // matches the /api/sources/:id pattern).
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

  // Existence check up front so we can return a clean 404 (vs the
  // ambiguous "0 rows changed" from hardDeleteStylePainting). Also
  // lets us skip the R2 enumeration when the row is already gone.
  const sp = getStylePainting(id);
  if (!sp) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const r2Keys = listAllR2KeysForStylePainting(id);

  // Atomic block: nullify tile references first (SQLite weak FK from
  // ALTER ADD COLUMN; without this the DELETE fails with FOREIGN KEY
  // constraint failed when any tile still references this style
  // painting) → hard-delete the row.
  let dbDeleted = false;
  let tilesOrphaned = 0;
  try {
    db().transaction(() => {
      tilesOrphaned = nullifyTilesForStylePainting(id);
      dbDeleted = hardDeleteStylePainting(id);
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
        `[style-paintings DELETE] R2 cleanup failed for id ${id} (${r2Keys.length} keys); DB row already removed`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return NextResponse.json(
    { id, deleted: true, r2KeysDeleted: r2Keys.length, tilesOrphaned },
    { status: 200 },
  );
}
