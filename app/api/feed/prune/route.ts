/**
 * POST /api/feed/prune — the knockoff sweep (AGENTS.md §18). Checks every
 * unsaved museum card's original against the naturalistic-only rule and
 * lists the ones that already look modern. Body `{ apply: true }` hides them
 * (status 'hidden' — nothing is deleted; hearted cards are never touched).
 * Without it, only reports.
 *
 * Auth required. runtime = 'nodejs' (sharp, R2, better-sqlite3).
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { judgeModernLook } from "@/lib/feed/engine";
import { hideCards, listUnsavedMuseumRoots } from "@/lib/feed/store";
import { getObject } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { apply?: unknown };
  const cards = listUnsavedMuseumRoots().filter((c) => c.orig_key);
  const images: Buffer[] = [];
  const checked: typeof cards = [];
  for (const c of cards) {
    try {
      images.push(await getObject(c.orig_key as string));
      checked.push(c);
    } catch {
      // unreadable original — leave the card alone
    }
  }
  let modern: boolean[];
  try {
    modern = await judgeModernLook(images);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const flagged = checked.filter((_, i) => modern[i]);
  if (body.apply === true) hideCards(flagged.map((c) => c.id), "already-modern source (knockoff sweep)");
  return NextResponse.json({
    checked: checked.length,
    applied: body.apply === true,
    flagged: flagged.map((c) => ({ id: c.id, title: c.title, byline: c.byline })),
  });
}
