/**
 * GET /api/feed/status — the painter's state, for debugging (AGENTS.md §18):
 * in flight, unseen stock per feed, today's starts vs the daily budget,
 * failures today with the last few errors, and why it's blocked if it is.
 *
 * Auth required. runtime = 'nodejs'.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { feedStatus } from "@/lib/feed/producer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json(feedStatus());
}
