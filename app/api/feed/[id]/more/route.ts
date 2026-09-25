/**
 * POST /api/feed/:id/more — "More like this" (AGENTS.md §18). Starts up to
 * four new pairs like this card (idempotent: never more than four per
 * card). The page calls it when she scrolls down into "More like this".
 *
 * Auth required. runtime = 'nodejs'.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { startMore } from "@/lib/feed/producer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const r = await startMore(id, 4);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  } catch (e) {
    console.error(`[feed] more-like-this ${id} failed:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, message: "Couldn't start more like this. Try again in a moment." }, { status: 502 });
  }
}
