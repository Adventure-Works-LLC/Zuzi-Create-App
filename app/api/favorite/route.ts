/**
 * POST /api/favorite — body {tileId, value: boolean}. Sets/clears tiles.is_favorite +
 * tiles.favorited_at. Returns {tileId, isFavorite, favoritedAt}.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { setFavorite } from "@/lib/db/queries";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { tileId?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tileId = typeof body.tileId === "string" ? body.tileId : null;
  const value = typeof body.value === "boolean" ? body.value : null;
  if (!tileId)
    return NextResponse.json({ error: "missing_tileId" }, { status: 400 });
  if (value === null)
    return NextResponse.json({ error: "missing_value" }, { status: 400 });

  const updated = setFavorite(tileId, value);
  if (!updated) {
    return NextResponse.json({ error: "tile_not_found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      tileId: updated.tile_id,
      isFavorite: updated.is_favorite === 1,
      favoritedAt: updated.favorited_at,
    },
    { status: 200 },
  );
}
