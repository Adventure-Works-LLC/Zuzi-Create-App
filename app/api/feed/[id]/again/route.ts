/**
 * POST /api/feed/:id/again — "Paint again" (AGENTS.md §18). Paints a new
 * version of her painting from the same original; the pair keeps every
 * version. One in flight per pair. Body { today: true } = "Bring it to
 * today": same poses, present-day clothes and activities.
 *
 * Auth required. runtime = 'nodejs'.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { startAgain } from "@/lib/feed/producer";

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
  let today = false;
  try {
    today = ((await req.json()) as { today?: unknown }).today === true;
  } catch {
    // no body = an ordinary "Paint again"
  }
  const r = startAgain(id, today);
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
