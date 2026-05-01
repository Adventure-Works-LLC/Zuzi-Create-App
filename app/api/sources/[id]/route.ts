/**
 * /api/sources/:id — toggle archive (PATCH) + permanent delete (DELETE).
 *
 *   PATCH  body { archived: boolean }
 *     Sets / clears sources.archived_at. Recoverable. Archived sources
 *     leave the active strip but their favorited tiles still appear in
 *     the global Favorites view (cross-source). The Hidden Sources panel
 *     surfaces archived sources for restoration.
 *
 *   DELETE
 *     Permanent hard delete. Drops the source row (cascades iterations
 *     + tiles via FK). Cleans up R2 storage best-effort: input image +
 *     every tile's output + thumb. Cannot be undone — the UI requires
 *     a window.confirm before invoking this path.
 *
 *     The DB delete runs in a transaction; R2 cleanup runs after the
 *     transaction commits. If R2 cleanup partially fails, we have
 *     orphaned R2 objects (acceptable — a future sweep job picks them
 *     up; user sees the source gone immediately, which matches the
 *     mental model). The reverse order would risk broken-image rows
 *     pointing at deleted R2 keys.
 *
 * Auth required on both. runtime = 'nodejs' for better-sqlite3 + R2 SDK.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { hardDeleteSource, setSourceArchived } from "@/lib/db/queries";
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

  // DB-first, R2-best-effort-after. If the DB delete fails, we abort and
  // R2 stays intact (no orphan risk). If R2 cleanup partially fails AFTER
  // DB success, the source is already gone from the user's perspective and
  // any leftover R2 objects sit there until a future sweep.
  let result;
  try {
    result = hardDeleteSource(id);
  } catch (e) {
    return NextResponse.json(
      {
        error: "db_delete_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  console.info("[api/sources/delete] db delete ok", {
    sourceId: result.sourceId,
    iterationCount: result.iterationCount,
    tileCount: result.tileCount,
    r2KeyCount: result.r2Keys.length,
  });

  // R2 cleanup. Failures logged + counted but don't fail the request — the
  // user's source is gone from the DB and the stream; orphan R2 cleanup is
  // an operational concern, not a user-facing one. The S3 batch API takes
  // up to 1000 keys per call; any source-with-iterations subtree we'd
  // realistically generate is well under that.
  let r2OrphanCount = 0;
  if (result.r2Keys.length > 0) {
    try {
      const errors = await deleteObjects(result.r2Keys);
      r2OrphanCount = errors.length;
      if (errors.length > 0) {
        console.warn("[api/sources/delete] r2 cleanup partial-fail", {
          sourceId: result.sourceId,
          orphanCount: errors.length,
          first5: errors.slice(0, 5),
        });
      }
    } catch (e) {
      r2OrphanCount = result.r2Keys.length;
      console.warn("[api/sources/delete] r2 cleanup threw", {
        sourceId: result.sourceId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json(
    {
      id: result.sourceId,
      iterationCount: result.iterationCount,
      tileCount: result.tileCount,
      r2KeyCount: result.r2Keys.length,
      r2OrphanCount,
    },
    { status: 200 },
  );
}
