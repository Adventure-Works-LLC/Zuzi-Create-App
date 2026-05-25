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
 *         id, sourceId, modelTier, resolution, aspectRatioMode, tileCount,
 *         presets, mode, parentTileId,
 *         status, createdAt, completedAt,
 *         tiles: [{ id, idx, status, outputKey, thumbKey, errorMessage,
 *                   isFavorite, favoritedAt, stylePaintingId,
 *                   createdAt, completedAt }]
 *       }
 *     ]
 *   }
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import {
  listIterations,
  tilesForIterations,
} from "@/lib/db/queries";
import {
  parseBlendStyleIdsJson,
  parseStoredPresets,
} from "@/lib/gemini/presets";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
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

  const iterations = iterRows
    .map((it) => {
      const ts = (tilesByIter.get(it.id) ?? []).slice().sort((a, b) => a.idx - b.idx);
      return {
        id: it.id,
        sourceId: it.source_id,
        modelTier: it.model_tier,
        resolution: it.resolution,
        aspectRatioMode: it.aspect_ratio_mode,
        tileCount: it.tile_count,
        presets: parseStoredPresets(it.presets),
        // v2 Style Explore fields. `mode` discriminates the iteration
        // type (Lightbox/InputBar branch off it); `parentTileId` is the
        // "Iterate on this direction" provenance link (NULL for
        // organically-generated iterations).
        mode: it.mode,
        parentTileId: it.parent_tile_id,
        // v3.0 style_blend: parse the JSON column into a string[]. Empty
        // array for every non-blend iteration. The client uses this to
        // render attribution chips on blend tiles (per-iteration; every
        // tile in a blend run shares the same N styles, so there's no
        // per-tile style_painting_id to read). `it.id` is passed as
        // context so corrupted rows surface in tails (matches the
        // parseStoredPresets context-passing pattern at line 83).
        blendStyleIds: parseBlendStyleIdsJson(it.blend_style_ids, it.id),
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
          // Per-tile style attribution for style_explore tiles, NULL
          // for prompt-mode tiles. Powers the StyleAttributionThumb
          // and the lightbox toolbar's "Iterate on this direction"
          // swap. Surfaced from the tiles row as-is — the StylesPanel
          // already hydrates the library so the client can look up
          // title/inputKey without an extra fetch.
          stylePaintingId: t.style_painting_id,
          createdAt: t.created_at,
          completedAt: t.completed_at,
        })),
      };
    })
    // Drop iterations whose tiles[] is empty (all soft-deleted, or never
    // had any). Belt-and-suspenders for the per-delete cleanup in
    // /api/tiles/:id — handles legacy data where every tile of an
    // iteration was soft-deleted before the cleanup path existed, AND
    // iterations whose worker never produced any tile rows (rare,
    // worker race). The IterationRow component renders a header + tile
    // grid; with `tiles: []` the header renders alone, which the user
    // sees as a phantom row. Filtering here removes it from the read
    // path. The boot-time sweep (instrumentation.ts) reaps the DB rows
    // on the next deploy so the filter doesn't carry indefinite
    // overhead.
    .filter((it) => it.tiles.length > 0);

  return NextResponse.json({ iterations }, { status: 200 });
}
