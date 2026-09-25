/**
 * POST /api/feed/:id/variant — a palette dot (AGENTS.md §18).
 * Body: { palette: PaletteKey }. Returns { url } for this card repainted in
 * that palette, painting it on first tap (~10–20s on Nano Banana 2) and
 * reusing it afterwards. Counts toward the shared monthly cap.
 *
 * Auth required. runtime = 'nodejs' (sharp, R2, better-sqlite3).
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { isPaletteKey } from "@/lib/feed/palettes";
import { ensureVariant } from "@/lib/feed/producer";
import { signedUrlFor } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  let palette: unknown;
  try {
    palette = ((await req.json()) as { palette?: unknown }).palette;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isPaletteKey(palette)) {
    return NextResponse.json({ error: "unknown_palette" }, { status: 400 });
  }
  try {
    const key = await ensureVariant(id, palette);
    return NextResponse.json({ url: await signedUrlFor(key, 3 * 3600) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "monthly_cap_reached" ? 429 : msg === "card not ready" ? 404 : 502;
    console.error(`[feed] variant ${id}/${palette} failed:`, msg);
    return NextResponse.json({ error: msg }, { status });
  }
}
