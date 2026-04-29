/**
 * GET /api/favorites — favorited tiles across ALL sources (active + archived).
 *
 * Query params:
 *   limit  default 50, max 100
 *   before cursor on favorited_at (millis); paginate by passing the last item's value
 *
 * Returns: { favorites: [{tileId, sourceId, sourceArchived, sourceAspectRatio,
 *           iterationId, outputKey, thumbKey, favoritedAt, createdAt, modelTier,
 *           resolution}] }
 *
 * Joins tiles → iterations → sources so the response carries everything the History
 * Drawer / CompareLightbox needs for one favorite without follow-up calls. Sorted
 * favorited_at DESC.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { listFavorites } from "@/lib/db/queries";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const beforeRaw = url.searchParams.get("before");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "50", 10) || 50, 1),
    100,
  );
  const before =
    beforeRaw !== null ? Number.parseInt(beforeRaw, 10) || undefined : undefined;

  const rows = listFavorites({ limit, before });

  return NextResponse.json(
    {
      favorites: rows.map((r) => ({
        tileId: r.tile_id,
        sourceId: r.source_id,
        sourceArchived: Boolean(r.source_archived),
        sourceAspectRatio: r.source_aspect_ratio,
        iterationId: r.iteration_id,
        outputKey: r.output_image_key,
        thumbKey: r.thumb_image_key,
        favoritedAt: r.favorited_at,
        createdAt: r.created_at,
        modelTier: r.model_tier,
        resolution: r.resolution,
      })),
    },
    { status: 200 },
  );
}
