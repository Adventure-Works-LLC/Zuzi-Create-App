/**
 * GET /api/feed — v7 Zuzi's Scroll (AGENTS.md §18).
 *
 *   ?feed=invented|museum  newest-first page of ready cards; `before` is a
 *                          readyAt cursor for older pages. `since` returns
 *                          cards that became ready after that readyAt,
 *                          oldest first (the page appends them live at the
 *                          bottom while she scrolls).
 *   ?feed=saved            hearted cards, newest heart first; `before` is a
 *                          savedAt cursor.
 *
 * Every feed read marks the returned cards as served and tops up that
 * feed's buffer (ensureBuffer) — this is what "paints as she scrolls".
 *
 * Response: { cards, nextBefore, painting } — `painting` is how many cards
 * of this feed are in flight right now.
 *
 * Auth required. runtime = 'nodejs' (better-sqlite3, sharp via producer).
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { toDTOs } from "@/lib/feed/dto";
import { ensureBuffer } from "@/lib/feed/producer";
import {
  countPending,
  isFeedName,
  listReady,
  listReadySince,
  listSaved,
  markServed,
} from "@/lib/feed/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(req.url);
  const feed = url.searchParams.get("feed") ?? "invented";
  const limit = Math.min(Math.max(num(url.searchParams.get("limit")) ?? 20, 1), 50);
  const before = num(url.searchParams.get("before"));
  const since = num(url.searchParams.get("since"));

  if (feed === "saved") {
    const rows = listSaved(limit, before);
    const cards = await toDTOs(rows);
    const last = rows[rows.length - 1];
    return NextResponse.json({
      cards,
      nextBefore: rows.length === limit && last?.saved_at ? last.saved_at : null,
      painting: 0,
    });
  }
  if (!isFeedName(feed)) {
    return NextResponse.json({ error: "invalid_feed" }, { status: 400 });
  }

  const rows = typeof since === "number" ? listReadySince(feed, since, limit) : listReady(feed, limit, before);
  markServed(rows.map((r) => r.id), Date.now());
  ensureBuffer(feed);
  const cards = await toDTOs(rows);
  const last = rows[rows.length - 1];
  return NextResponse.json({
    cards,
    nextBefore: typeof since !== "number" && rows.length === limit && last?.ready_at ? last.ready_at : null,
    painting: countPending(feed),
  });
}
