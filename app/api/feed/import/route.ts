/**
 * POST /api/feed/import — load pre-made cards into the Scroll (AGENTS.md §18).
 *
 * Used once to seed the feed with the 54 cards painted in the Sept 2026 lab,
 * so the home page opens full instead of waiting on the painter. The images
 * must already be in R2 under feed/<id>/…; this only writes rows.
 * Idempotent by id (existing ids are skipped). Seed ids start with "seed-"
 * and don't count toward the daily painting budget.
 *
 * Body: { cards: Array<{ id, feed, title, afterLabel, byline, sourceUrl?,
 *   sourceRef?, origKey, origW, origH, herKey, herW, herH, palettes: string[],
 *   variants: Record<string,string>, readyAt }> }
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { isPaletteKey } from "@/lib/feed/palettes";
import { insertCardIfAbsent, isFeedName, setBriefIfMissing } from "@/lib/feed/store";

export const runtime = "nodejs";

interface ImportCard {
  id: string;
  feed: string;
  title: string;
  afterLabel: string;
  byline: string;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  origKey: string;
  origW: number;
  origH: number;
  herKey: string;
  herW: number;
  herH: number;
  palettes: string[];
  variants: Record<string, string>;
  readyAt: number;
  brief?: Record<string, unknown>;
}

const KEY_OK = (k: unknown): k is string => typeof k === "string" && k.startsWith("feed/") && !k.includes("..") && k.length < 256;

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { cards?: ImportCard[] };
  try {
    body = (await req.json()) as { cards?: ImportCard[] };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const cards = Array.isArray(body.cards) ? body.cards.slice(0, 500) : [];
  let inserted = 0, skipped = 0, rejected = 0, briefed = 0;
  for (const c of cards) {
    if (typeof c?.id !== "string" || !c.id.startsWith("seed-") || !isFeedName(c.feed) || !KEY_OK(c.herKey) || !KEY_OK(c.origKey)) {
      rejected++;
      continue;
    }
    const variants: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.variants ?? {})) if (isPaletteKey(k) && KEY_OK(v)) variants[k] = v;
    const ok = insertCardIfAbsent({
      id: c.id,
      feed: c.feed,
      status: "ready",
      title: String(c.title).slice(0, 200),
      after_label: String(c.afterLabel).slice(0, 200),
      byline: String(c.byline).slice(0, 300),
      source_url: c.sourceUrl ?? null,
      source_ref: c.sourceRef ?? null,
      orig_key: c.origKey,
      orig_w: c.origW,
      orig_h: c.origH,
      her_key: c.herKey,
      her_w: c.herW,
      her_h: c.herH,
      palettes: JSON.stringify((c.palettes ?? []).filter(isPaletteKey)),
      variants: JSON.stringify(variants),
      brief: c.brief ? JSON.stringify(c.brief) : null,
      created_at: c.readyAt,
      ready_at: c.readyAt,
    });
    if (ok) inserted++;
    else {
      skipped++;
      // Re-import fills in a brief the first import didn't carry (cast keys etc.).
      if (c.brief && setBriefIfMissing(c.id, JSON.stringify(c.brief))) briefed++;
    }
  }
  return NextResponse.json({ inserted, skipped, rejected, briefed });
}
