/**
 * POST /api/feed/:id/matisse — the "Painted by Matisse" checkbox (AGENTS.md
 * §18). Returns { url } once this card's original has been painted as if by
 * Matisse; until then starts the painting (~2 min on GPT Image 2) and returns
 * 202 { painting: true } — the page polls. Counts toward the monthly cap.
 *
 * Auth required. runtime = 'nodejs' (sharp, R2, better-sqlite3).
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { matisseStatus } from "@/lib/feed/producer";
import { signedUrlFor } from "@/lib/storage/r2";

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
  const s = matisseStatus(id);
  if ("key" in s) return NextResponse.json({ url: await signedUrlFor(s.key, 3 * 3600) });
  if ("painting" in s) return NextResponse.json({ painting: true }, { status: 202 });
  const status = s.error === "monthly_cap_reached" ? 429 : s.error === "card not ready" ? 404 : 502;
  return NextResponse.json({ error: s.error }, { status });
}
