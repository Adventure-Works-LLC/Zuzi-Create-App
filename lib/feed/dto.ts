/**
 * v7 Zuzi's Scroll — the card shape the feed page receives. Image URLs are
 * presigned here (3h TTL, auth-gated at issuance like /api/image-url — see
 * AGENTS.md §7) so one feed read carries everything the page needs.
 */

import type { FeedCard } from "@/lib/db/schema";
import { signedUrlFor } from "@/lib/storage/r2";

import { PALETTES, isPaletteKey } from "./palettes";
import { parseJson } from "./store";

const TTL = 3 * 3600;

/** Every original has a small sibling for the "after …" chip: feed/<id>/orig.jpg → feed/<id>/orig-t.jpg. */
export function thumbKey(origKey: string): string {
  return origKey.replace(/\.jpg$/, "-t.jpg");
}

export interface CardDTO {
  id: string;
  feed: "invented" | "museum";
  title: string;
  afterLabel: string;
  byline: string;
  sourceUrl: string | null;
  her: { url: string; w: number; h: number };
  orig: { url: string; thumb: string; w: number; h: number } | null;
  palettes: { key: string; name: string; chips: string[]; url: string | null }[];
  saved: boolean;
  savedPalette: string | null;
  readyAt: number;
  savedAt: number | null;
}

export async function toDTO(c: FeedCard): Promise<CardDTO | null> {
  if (!c.her_key) return null;
  const vars = parseJson<Record<string, string>>(c.variants, {});
  const keys = parseJson<string[]>(c.palettes, []).filter(isPaletteKey);
  return {
    id: c.id,
    feed: c.feed,
    title: c.title,
    afterLabel: c.after_label,
    byline: c.byline,
    sourceUrl: c.source_url,
    her: { url: await signedUrlFor(c.her_key, TTL), w: c.her_w ?? 1024, h: c.her_h ?? 1280 },
    orig: c.orig_key
      ? { url: await signedUrlFor(c.orig_key, TTL), thumb: await signedUrlFor(thumbKey(c.orig_key), TTL), w: c.orig_w ?? 1024, h: c.orig_h ?? 1280 }
      : null,
    palettes: await Promise.all(
      keys.map(async (k) => ({
        key: k,
        name: PALETTES[k].name,
        chips: PALETTES[k].chips,
        url: vars[k] ? await signedUrlFor(vars[k], TTL) : null,
      })),
    ),
    saved: c.saved_at !== null,
    savedPalette: c.saved_palette,
    readyAt: c.ready_at ?? c.created_at,
    savedAt: c.saved_at,
  };
}

export async function toDTOs(rows: FeedCard[]): Promise<CardDTO[]> {
  return (await Promise.all(rows.map(toDTO))).filter((x): x is CardDTO => x !== null);
}
