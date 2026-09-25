/**
 * PATCH /api/feed/:id — heart or un-heart a Scroll card (AGENTS.md §18).
 * Body: { saved: boolean, palette?: string } — `palette` records which
 * colors were showing when she hearted it ("as made" or a palette key),
 * the taste signal for later.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { isPaletteKey } from "@/lib/feed/palettes";
import { getCard, updateCard } from "@/lib/feed/store";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const card = getCard(id);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: { saved?: unknown; palette?: unknown };
  try {
    body = (await req.json()) as { saved?: unknown; palette?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.saved !== "boolean") {
    return NextResponse.json({ error: "saved_must_be_boolean" }, { status: 400 });
  }
  const palette = isPaletteKey(body.palette) ? body.palette : "as made";
  updateCard(id, body.saved ? { saved_at: Date.now(), saved_palette: palette } : { saved_at: null, saved_palette: null });
  return NextResponse.json({ id, saved: body.saved, palette: body.saved ? palette : null });
}
