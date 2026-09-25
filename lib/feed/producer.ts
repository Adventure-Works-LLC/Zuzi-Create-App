/**
 * v7 Zuzi's Scroll — the painter queue (AGENTS.md §18).
 *
 * SINGLE-INSTANCE ONLY (AGENTS.md §1 / plan §Hosting): the queue, the idea
 * buffer and the museum candidate pool live in this process's memory. On a
 * second instance they would double-paint and double-spend.
 *
 * "Paints as she scrolls": every feed read calls ensureBuffer(feed), which
 * keeps FEED_BUFFER ready-but-unseen cards (plus in-flight ones) per feed.
 * A card takes ~2–3 minutes (Nano Banana Pro original + GPT Image 2 her
 * version), so the buffer — refilled on every read and by a 10-minute boot
 * interval — is what keeps her from waiting. Spend guards: FEED_DAILY_CARDS
 * started per UTC day, and the shared MONTHLY_USD_CAP (monthlyUsageUsd
 * includes feed spend).
 */

import { ulid } from "ulid";

import { FEED_PRICE_USD } from "@/lib/cost";
import { monthlyUsageUsd } from "@/lib/db/queries";
import { putObject } from "@/lib/storage/r2";

import {
  castImages,
  dims,
  fetchImage,
  judgeMuseum,
  museumCandidates,
  paintHers,
  paintOriginal,
  recolor,
  toJpeg,
  writeBriefs,
  type JudgedCandidate,
} from "./engine";
import { HER_PALETTES, PALETTES, isPaletteKey, pickPalettes, type PaletteKey } from "./palettes";
import {
  hersFromInventedPrompt,
  hersFromMuseumPrompt,
  originalPrompt,
  recolorPrompt,
  type InventedBrief,
} from "./prompts";
import {
  addCost,
  countPending,
  countReadyUnserved,
  countStartedSince,
  getCard,
  insertCard,
  parseJson,
  recentTitles,
  updateCard,
  usedMuseumRefs,
  type FeedName,
} from "./store";

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}
const bufferTarget = () => envInt("FEED_BUFFER", 10);
const dailyCards = () => envInt("FEED_DAILY_CARDS", 60);
const maxParallel = () => Math.max(1, envInt("FEED_PARALLEL", 6));
function monthlyCap(): number {
  const v = Number(process.env.MONTHLY_USD_CAP ?? "250");
  return Number.isFinite(v) && v > 0 ? v : 250;
}

let running = 0;
const briefs: InventedBrief[] = [];
const museumPool: JudgedCandidate[] = [];
let refillingBriefs: Promise<void> | null = null;
let refillingMuseum: Promise<void> | null = null;

function dayStartUtc(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

export function feedStatus() {
  return { running, briefsQueued: briefs.length, museumPool: museumPool.length };
}

/** Top up this feed's buffer. Cheap to call on every read; never throws. */
export function ensureBuffer(feed: FeedName): void {
  try {
    const have = countReadyUnserved(feed) + countPending(feed);
    let want = bufferTarget() - have;
    if (want <= 0) return;
    const budgetLeft = dailyCards() - countStartedSince(dayStartUtc());
    if (budgetLeft <= 0) return;
    if (monthlyUsageUsd() >= monthlyCap()) return;
    want = Math.min(want, budgetLeft, maxParallel() - running);
    for (let i = 0; i < want; i++) startJob(feed);
  } catch (e) {
    console.error("[feed] ensureBuffer failed:", e instanceof Error ? e.message : e);
  }
}

function startJob(feed: FeedName): void {
  const id = ulid();
  const now = Date.now();
  const seed = Math.floor(Math.random() * 1000);
  const asMade = HER_PALETTES[seed % HER_PALETTES.length];
  insertCard({
    id,
    feed,
    status: "pending",
    title: "Painting…",
    after_label: "",
    byline: "",
    palettes: JSON.stringify(pickPalettes(seed + 1).filter((k) => k !== asMade).slice(0, 3)),
    brief: JSON.stringify({ asMade }),
    created_at: now,
  });
  running++;
  const job = feed === "invented" ? paintInvented(id, asMade) : paintMuseum(id, asMade);
  job
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[feed] card ${id} (${feed}) failed:`, msg);
      updateCard(id, { status: "failed", error: msg.slice(0, 500) });
    })
    .finally(() => {
      running--;
    });
}

async function nextBrief(): Promise<InventedBrief> {
  for (let attempt = 0; attempt < 3 && briefs.length === 0; attempt++) {
    if (!refillingBriefs) {
      refillingBriefs = (async () => {
        try {
          const got = await writeBriefs(8, recentTitles(60));
          briefs.push(...got);
        } finally {
          refillingBriefs = null;
        }
      })();
    }
    await refillingBriefs.catch((e) => console.warn("[feed] idea-writer failed:", e instanceof Error ? e.message : e));
  }
  const b = briefs.shift();
  if (!b) throw new Error("idea-writer returned no briefs");
  return b;
}

async function nextMuseum(): Promise<JudgedCandidate> {
  for (let attempt = 0; attempt < 3 && museumPool.length === 0; attempt++) {
    if (!refillingMuseum) {
      refillingMuseum = (async () => {
        try {
          const used = usedMuseumRefs();
          for (const c of museumPool) used.add(c.ref);
          const cands = (await museumCandidates(used, 2)).sort(() => Math.random() - 0.5).slice(0, 30);
          museumPool.push(...(await judgeMuseum(cands)));
        } finally {
          refillingMuseum = null;
        }
      })();
    }
    await refillingMuseum.catch((e) => console.warn("[feed] museum refill failed:", e instanceof Error ? e.message : e));
  }
  const c = museumPool.shift();
  if (!c) throw new Error("no museum candidates found");
  return c;
}

async function paintInvented(id: string, asMade: PaletteKey): Promise<void> {
  const b = await nextBrief();
  addCost(id, FEED_PRICE_USD.text / 8);
  updateCard(id, {
    title: b.title,
    after_label: `after an invented ${b.era} painting`.replace(/painting painting$/, "painting"),
    byline: `${b.era}, ${b.date} · ${b.medium} · invented; this painting does not exist`,
    brief: JSON.stringify({ ...b, asMade }),
  });
  const orig = await paintOriginal(originalPrompt(b), b.aspect);
  addCost(id, FEED_PRICE_USD.original);
  const od = await dims(orig);
  await putObject(`feed/${id}/orig.jpg`, orig, "image/jpeg");
  await putObject(`feed/${id}/orig-t.jpg`, await toJpeg(orig, 120, 76), "image/jpeg");
  updateCard(id, { orig_key: `feed/${id}/orig.jpg`, orig_w: od.w, orig_h: od.h });
  const hers = await paintHers(orig, await castImages(b.cast), hersFromInventedPrompt(PALETTES[asMade].text));
  addCost(id, FEED_PRICE_USD.hers);
  const hd = await dims(hers);
  await putObject(`feed/${id}/her.jpg`, hers, "image/jpeg");
  updateCard(id, { her_key: `feed/${id}/her.jpg`, her_w: hd.w, her_h: hd.h, status: "ready", ready_at: Date.now() });
}

async function paintMuseum(id: string, asMade: PaletteKey): Promise<void> {
  const c = await nextMuseum();
  updateCard(id, {
    title: c.title,
    after_label: `after ${c.artist}`,
    byline: `${c.artist}${c.date ? ", " + c.date : ""} · ${c.museum}`,
    source_url: c.page,
    source_ref: c.ref,
    brief: JSON.stringify({ cast: c.cast, rhyme: c.rhyme, asMade }),
  });
  const orig = await toJpeg(await fetchImage(c.image), 1280, 88);
  const od = await dims(orig);
  await putObject(`feed/${id}/orig.jpg`, orig, "image/jpeg");
  await putObject(`feed/${id}/orig-t.jpg`, await toJpeg(orig, 120, 76), "image/jpeg");
  updateCard(id, { orig_key: `feed/${id}/orig.jpg`, orig_w: od.w, orig_h: od.h });
  const hers = await paintHers(orig, await castImages(c.cast), hersFromMuseumPrompt(PALETTES[asMade].text));
  addCost(id, FEED_PRICE_USD.hers);
  const hd = await dims(hers);
  await putObject(`feed/${id}/her.jpg`, hers, "image/jpeg");
  updateCard(id, { her_key: `feed/${id}/her.jpg`, her_w: hd.w, her_h: hd.h, status: "ready", ready_at: Date.now() });
}

// ------------------------------------------------------------ palette dots

const variantJobs = new Map<string, Promise<string>>();

/**
 * The R2 key of this card's recolor in `palette`, painting it on first tap.
 * Concurrent taps on the same dot share one job.
 */
export async function ensureVariant(cardId: string, palette: string): Promise<string> {
  if (!isPaletteKey(palette)) throw new Error("unknown palette");
  const card = getCard(cardId);
  if (!card || card.status !== "ready" || !card.her_key) throw new Error("card not ready");
  const existing = parseJson<Record<string, string>>(card.variants, {});
  if (existing[palette]) return existing[palette];
  if (monthlyUsageUsd() >= monthlyCap()) throw new Error("monthly_cap_reached");
  const jobKey = `${cardId}:${palette}`;
  let job = variantJobs.get(jobKey);
  if (!job) {
    job = (async () => {
      const { getObject } = await import("@/lib/storage/r2");
      const src = await getObject(card.her_key as string);
      const out = await recolor(src, recolorPrompt(PALETTES[palette].text));
      addCost(cardId, FEED_PRICE_USD.recolor);
      const key = `feed/${cardId}/var-${palette}.jpg`;
      await putObject(key, out, "image/jpeg");
      const fresh = getCard(cardId);
      const vars = parseJson<Record<string, string>>(fresh?.variants, {});
      vars[palette] = key;
      updateCard(cardId, { variants: JSON.stringify(vars) });
      return key;
    })().finally(() => variantJobs.delete(jobKey));
    variantJobs.set(jobKey, job);
  }
  return job;
}
