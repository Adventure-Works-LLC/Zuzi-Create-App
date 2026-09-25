/**
 * The v7.3 repaint (AGENTS.md §18): repaint the her versions of unsaved
 * main-feed cards made before `before` (ms) in the v7.3 style.
 *   POST { before }                 → reports how many and the estimated cost
 *   POST { before, apply: true }    → starts the background repaint
 *   GET                             → progress
 * Hearted cards are never touched; the old image is kept (variants
 * "v72:her"). Counts toward the monthly cap.
 *
 * Auth required. runtime = 'nodejs' (sharp, R2, better-sqlite3).
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { FEED_PRICE_USD } from "@/lib/cost";
import { PREVIOUS_HER_KEY, repaintStatus, startRepaint } from "@/lib/feed/producer";
import { listUnsavedRootsBefore, parseJson } from "@/lib/feed/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json(repaintStatus());
}

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { before?: unknown; apply?: unknown };
  if (typeof body.before !== "number") {
    return NextResponse.json({ error: "before (ms timestamp) required" }, { status: 400 });
  }
  const ids = listUnsavedRootsBefore(body.before)
    .filter((c) => !parseJson<Record<string, string>>(c.variants, {})[PREVIOUS_HER_KEY])
    .map((c) => c.id);
  const estimate = Math.round(ids.length * FEED_PRICE_USD.hers * 100) / 100;
  if (body.apply !== true) return NextResponse.json({ cards: ids.length, estimateUsd: estimate });
  const started = startRepaint(ids);
  return NextResponse.json({ started, cards: ids.length, estimateUsd: estimate, status: repaintStatus() });
}
