/**
 * GET /api/iterations?sourceId=<id>&limit=50&before=<ts>
 *
 * Returns the iteration history (with embedded tiles) for the given source —
 * the data the Studio's tile stream renders newest-first. Pagination cursor is
 * `before` (millis) on `iterations.created_at`.
 *
 * Embedding tiles in the iteration response keeps the client to one fetch per
 * source switch (instead of N+1). The query uses `tilesForIterations` (single
 * `IN (...)` query) and groups in JS.
 *
 * Response shape:
 *   {
 *     iterations: [
 *       {
 *         id, sourceId, modelTier, resolution, tileCount, presets,
 *         status, createdAt, completedAt,
 *         tiles: [{ id, idx, status, outputKey, thumbKey, errorMessage,
 *                   isFavorite, favoritedAt, createdAt, completedAt }]
 *       }
 *     ]
 *   }
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  listIterations,
  tilesForIterations,
} from "@/lib/db/queries";
import { parseStoredPresets } from "@/lib/gemini/presets";

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
  const sourceId = url.searchParams.get("sourceId") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const beforeRaw = url.searchParams.get("before");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "50", 10) || 50, 1),
    100,
  );
  const before =
    beforeRaw !== null
      ? Number.parseInt(beforeRaw, 10) || undefined
      : undefined;

  const iterRows = listIterations({
    limit,
    before,
    sourceId: sourceId || undefined,
  });

  const iterIds = iterRows.map((i) => i.id);
  const tileRows = tilesForIterations(iterIds);
  const tilesByIter = new Map<string, typeof tileRows>();
  for (const t of tileRows) {
    const arr = tilesByIter.get(t.iteration_id) ?? [];
    arr.push(t);
    tilesByIter.set(t.iteration_id, arr);
  }

  const iterations = iterRows.map((it) => {
    const ts = (tilesByIter.get(it.id) ?? []).slice().sort((a, b) => a.idx - b.idx);
    return {
      id: it.id,
      sourceId: it.source_id,
      modelTier: it.model_tier,
      resolution: it.resolution,
      aspectRatioMode: it.aspect_ratio_mode,
      tileCount: it.tile_count,
      presets: parseStoredPresets(it.presets),
      status: it.status,
      createdAt: it.created_at,
      completedAt: it.completed_at,
      tiles: ts.map((t) => ({
        id: t.id,
        idx: t.idx,
        status: t.status,
        outputKey: t.output_image_key,
        thumbKey: t.thumb_image_key,
        errorMessage: t.error_message,
        isFavorite: t.is_favorite === 1,
        favoritedAt: t.favorited_at,
        createdAt: t.created_at,
        completedAt: t.completed_at,
      })),
    };
  });

  return NextResponse.json({ iterations }, { status: 200 });
}
