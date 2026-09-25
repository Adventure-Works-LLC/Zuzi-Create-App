/**
 * v7 Zuzi's Scroll — the painter queue (AGENTS.md §18).
 *
 * SINGLE-INSTANCE ONLY (AGENTS.md §1 / plan §Hosting): the queue, the idea
 * buffer and the museum candidate pool live in this process's memory. On a
 * second instance they would double-paint and double-spend.
 *
 * Every card is a PAIR — the painting (invented or museum) + her version —
 * and stays that way. Three kinds of work:
 *   - feed cards: ensureBuffer(feed) keeps FEED_BUFFER (default 24) unseen +
 *     in-flight root cards per feed, so the bottom of the scroll is rarely
 *     reached; a card takes ~2–3 min.
 *   - "Paint again" (startAgain): a new version of her painting from the
 *     SAME original — a child card sharing the parent's orig_key.
 *   - "More like this" (startMore): new pairs like the parent — sibling
 *     briefs for invented cards, more by the same artist for museum cards.
 * Children (parent_id set) never count toward the feed buffer and never
 * appear in the main feed. Spend guards: FEED_DAILY_CARDS started per UTC
 * day, and the shared MONTHLY_USD_CAP (monthlyUsageUsd includes feed spend).
 */

import { ulid } from "ulid";

import { FEED_PRICE_USD } from "@/lib/cost";
import { monthlyUsageUsd } from "@/lib/db/queries";
import type { FeedCard } from "@/lib/db/schema";
import { getObject, putObject } from "@/lib/storage/r2";

import {
  castImages,
  catalogCandidates,
  dims,
  fetchImage,
  isPainterLocked,
  judgeMuseum,
  matisseImages,
  museumCandidates,
  paintHers,
  painterAvailable,
  paintOriginal,
  recolor,
  toJpeg,
  writeBriefs,
  writeLikeBriefs,
  type JudgedCandidate,
  type MuseumCandidate,
} from "./engine";
import { pickMatisseRefs } from "./matisse";
import { HER_PALETTES, PALETTES, isPaletteKey, pickPalettes, type PaletteKey } from "./palettes";
import {
  hersFromInventedPrompt,
  hersFromMuseumPrompt,
  hersTodayPrompt,
  matissePrompt,
  modernOriginalPrompt,
  originalPrompt,
  recolorPrompt,
  type InventedBrief,
} from "./prompts";
import {
  addCost,
  countPending,
  countReadyUnserved,
  countStartedSince,
  countStartedTodayFailed,
  getCard,
  insertCard,
  listChildren,
  parseJson,
  recentTitles,
  updateCard,
  usedMuseumRefs,
  type FeedName,
} from "./store";

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}
const bufferTarget = () => envInt("FEED_BUFFER", 20);
const dailyCards = () => envInt("FEED_DAILY_CARDS", 120);
/** Painting slots PER FEED, so one tab can never starve another (v7.1.1). */
const maxParallel = () => Math.max(1, envInt("FEED_PARALLEL", 4));
function monthlyCap(): number {
  const v = Number(process.env.MONTHLY_USD_CAP ?? "250");
  return Number.isFinite(v) && v > 0 ? v : 250;
}

let running = 0;
const rootRunning: Record<FeedName, number> = { museum: 0, modern: 0, invented: 0 };
const briefs: InventedBrief[] = [];
const modernBriefs: InventedBrief[] = [];
const museumPool: JudgedCandidate[] = [];
let refillingBriefs: Promise<void> | null = null;
let refillingModern: Promise<void> | null = null;
let refillingMuseum: Promise<void> | null = null;

function dayStartUtc(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

/**
 * Safety stop for an empty fal balance (Sept 25 2026: the account locked
 * mid-afternoon). Without it the producer keeps starting cards that are bound
 * to fail — and invented cards pay for their original before they reach fal.
 * A locked failure stops new work; while stopped, fal is asked at most every
 * 15 minutes (for free) whether it's back.
 */
let painterLockedAt = 0;
let painterProbeAt = 0;

function painterLocked(): boolean {
  if (!painterLockedAt) return false;
  if (Date.now() - painterProbeAt > 15 * 60_000) {
    painterProbeAt = Date.now();
    void painterAvailable().then((ok) => {
      if (ok) painterLockedAt = 0;
    });
  }
  return true;
}

function notePainterFailure(message: string): void {
  if (!isPainterLocked(message)) return;
  if (!painterLockedAt) console.error("[feed] fal balance exhausted — pausing new paintings until it's topped up");
  painterLockedAt = painterLockedAt || Date.now();
  painterProbeAt = Date.now();
}

/** Why the painter isn't starting more right now, or null if it can. */
function blockedReason(): "daily" | "monthly" | "painter" | null {
  if (painterLocked()) return "painter";
  if (countStartedSince(dayStartUtc()) >= dailyCards()) return "daily";
  if (monthlyUsageUsd() >= monthlyCap()) return "monthly";
  return null;
}

export function feedStatus() {
  const today = dayStartUtc();
  return {
    running,
    runningByFeed: { ...rootRunning },
    briefsQueued: briefs.length,
    museumPool: museumPool.length,
    startedToday: countStartedSince(today),
    dailyLimit: dailyCards(),
    buffer: bufferTarget(),
    pending: { invented: countPending("invented"), museum: countPending("museum"), modern: countPending("modern") },
    readyUnseen: { invented: countReadyUnserved("invented"), museum: countReadyUnserved("museum"), modern: countReadyUnserved("modern") },
    blocked: blockedReason(),
    ...countStartedTodayFailed(today),
  };
}

/** Top up this feed's buffer. Cheap to call on every read; never throws. Returns why it stopped, if it did. */
export function ensureBuffer(feed: FeedName): "daily" | "monthly" | "painter" | null {
  try {
    const have = countReadyUnserved(feed) + countPending(feed);
    let want = bufferTarget() - have;
    if (want <= 0) return null;
    const blocked = blockedReason();
    if (blocked) return blocked;
    want = Math.min(want, dailyCards() - countStartedSince(dayStartUtc()), maxParallel() - rootRunning[feed]);
    for (let i = 0; i < want; i++) startJob({ feed });
    return null;
  } catch (e) {
    console.error("[feed] ensureBuffer failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

interface JobOpts {
  feed: FeedName;
  parent?: FeedCard;
  kind?: "version" | "like";
  today?: boolean;
  brief?: InventedBrief;
  candidate?: JudgedCandidate;
}

function startJob(o: JobOpts): string {
  const id = ulid();
  const seed = Math.floor(Math.random() * 1000);
  const asMade = HER_PALETTES[seed % HER_PALETTES.length];
  insertCard({
    id,
    feed: o.feed,
    status: "pending",
    title: o.parent?.title ?? "Painting…",
    after_label: o.parent && o.kind === "version" ? o.parent.after_label : "",
    byline: o.parent && o.kind === "version" ? o.parent.byline : "",
    palettes: JSON.stringify(pickPalettes(seed + 1).filter((k) => k !== asMade).slice(0, 3)),
    brief: JSON.stringify({ asMade }),
    parent_id: o.parent?.id ?? null,
    created_at: Date.now(),
  });
  running++;
  const isRoot = !o.parent;
  if (isRoot) rootRunning[o.feed]++;
  const job =
    o.kind === "version" && o.parent
      ? paintVersion(id, o.parent, asMade, o.today === true)
      : o.feed === "museum"
        ? paintMuseum(id, asMade, o.candidate)
        : paintInvented(id, asMade, o.brief, o.feed === "modern");
  job
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[feed] card ${id} (${o.feed}${o.kind ? "/" + o.kind : ""}) failed:`, msg);
      notePainterFailure(msg);
      updateCard(id, { status: "failed", error: msg.slice(0, 500) });
    })
    .finally(() => {
      running--;
      if (isRoot) rootRunning[o.feed]--;
    });
  return id;
}

async function nextBrief(modern = false): Promise<InventedBrief> {
  const queue = modern ? modernBriefs : briefs;
  for (let attempt = 0; attempt < 3 && queue.length === 0; attempt++) {
    let refill = modern ? refillingModern : refillingBriefs;
    if (!refill) {
      refill = (async () => {
        try {
          queue.push(...(await writeBriefs(8, recentTitles(80), modern)));
        } finally {
          if (modern) refillingModern = null;
          else refillingBriefs = null;
        }
      })();
      if (modern) refillingModern = refill;
      else refillingBriefs = refill;
    }
    await refill.catch((e) => console.warn("[feed] idea-writer failed:", e instanceof Error ? e.message : e));
  }
  const b = queue.shift();
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
          let cands: MuseumCandidate[] = await catalogCandidates({ exclude: used, limit: 30 }).catch((e) => {
            console.warn("[feed] blue-chip catalog failed, falling back to museum search:", e instanceof Error ? e.message : e);
            return [] as MuseumCandidate[];
          });
          if (cands.length < 5) cands = cands.concat(await museumCandidates(used, 2));
          museumPool.push(...(await judgeMuseum(cands.slice(0, 30))));
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

/** R2 writes retry a few times — transient TLS resets happen (seen Sept 2026). */
async function put(key: string, body: Buffer): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await putObject(key, body, "image/jpeg");
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function storeOriginal(id: string, orig: Buffer): Promise<void> {
  const od = await dims(orig);
  await put(`feed/${id}/orig.jpg`, orig);
  await put(`feed/${id}/orig-t.jpg`, await toJpeg(orig, 120, 76));
  updateCard(id, { orig_key: `feed/${id}/orig.jpg`, orig_w: od.w, orig_h: od.h });
}

async function storeHers(id: string, hers: Buffer): Promise<void> {
  const hd = await dims(hers);
  await put(`feed/${id}/her.jpg`, hers);
  updateCard(id, { her_key: `feed/${id}/her.jpg`, her_w: hd.w, her_h: hd.h, status: "ready", ready_at: Date.now() });
}

async function paintInvented(id: string, asMade: PaletteKey, given?: InventedBrief, modern = false): Promise<void> {
  const b = given ?? (await nextBrief(modern));
  addCost(id, FEED_PRICE_USD.text / 8);
  updateCard(id, {
    title: b.title,
    after_label: `after an invented ${b.era} painting`.replace(/painting painting$/, "painting"),
    byline: `${b.era}, ${b.date} · ${b.medium} · invented; this painting does not exist`,
    brief: JSON.stringify({ ...b, asMade }),
  });
  const orig = await paintOriginal(modern ? modernOriginalPrompt(b) : originalPrompt(b), b.aspect);
  addCost(id, FEED_PRICE_USD.original);
  await storeOriginal(id, orig);
  // Jeff, Sept 25 2026: invented scenes read "ancient clothes doing ancient
  // things" — about half of the Invented feed is brought to today (same
  // poses, present-day clothes and activities). Modern is already today.
  const today = !modern && Math.random() < 0.5;
  if (today) updateCard(id, { brief: JSON.stringify({ ...b, asMade, today: true }) });
  const prompt = today ? hersTodayPrompt(PALETTES[asMade].text) : hersFromInventedPrompt(PALETTES[asMade].text);
  const hers = await paintHers(orig, await castImages(b.cast), prompt);
  addCost(id, FEED_PRICE_USD.hers);
  await storeHers(id, hers);
}

async function paintMuseum(id: string, asMade: PaletteKey, given?: JudgedCandidate): Promise<void> {
  const c = given ?? (await nextMuseum());
  updateCard(id, {
    title: c.title,
    after_label: `after ${c.artist}`,
    byline: `${c.artist}${c.date ? ", " + c.date : ""} · ${c.museum}`,
    source_url: c.page,
    source_ref: c.ref,
    brief: JSON.stringify({ cast: c.cast, rhyme: c.rhyme, artist: c.artist, creatorQid: c.creatorQid, asMade }),
  });
  const orig = await toJpeg(await fetchImage(c.image), 1280, 88);
  await storeOriginal(id, orig);
  const hers = await paintHers(orig, await castImages(c.cast), hersFromMuseumPrompt(PALETTES[asMade].text));
  addCost(id, FEED_PRICE_USD.hers);
  await storeHers(id, hers);
}

/** "Paint again": a fresh version of her painting from the parent's original. */
async function paintVersion(id: string, parent: FeedCard, asMade: PaletteKey, today: boolean): Promise<void> {
  if (!parent.orig_key) throw new Error("parent has no original");
  const pb = parseJson<{ cast?: string[]; asMade?: string }>(parent.brief, {});
  // A different palette from the parent's, so the new version reads as new.
  const palette = HER_PALETTES.find((k) => k !== pb.asMade && k !== asMade) ?? asMade;
  updateCard(id, {
    orig_key: parent.orig_key,
    orig_w: parent.orig_w,
    orig_h: parent.orig_h,
    source_url: parent.source_url,
    brief: JSON.stringify({ ...pb, asMade: palette, versionOf: parent.id, today }),
  });
  const orig = await getObject(parent.orig_key);
  const prompt = today
    ? hersTodayPrompt(PALETTES[palette].text)
    : parent.feed === "museum"
      ? hersFromMuseumPrompt(PALETTES[palette].text)
      : hersFromInventedPrompt(PALETTES[palette].text);
  const hers = await paintHers(orig, await castImages(pb.cast ?? ["cat", "chef"]), prompt);
  addCost(id, FEED_PRICE_USD.hers);
  await storeHers(id, hers);
}

function canStartChildren(): string | null {
  const blocked = blockedReason();
  if (blocked === "daily") return "Today's painting budget is used up. More tomorrow.";
  if (blocked === "monthly") return "This month's painting budget is used up.";
  if (blocked === "painter") return "Painting is paused right now. Try again a little later.";
  return null;
}

/**
 * "Paint again" on a card: a new version from the same original. Versions
 * always hang off the root pair (tapping it on a version paints another
 * version of the same original). One in flight per pair at a time.
 */
export function startAgain(cardId: string, today = false): { ok: boolean; message?: string } {
  const card = getCard(cardId);
  if (!card || card.status !== "ready" || !card.orig_key) return { ok: false, message: "That painting isn't ready yet." };
  const parent = card.parent_id ? getCard(card.parent_id) : undefined;
  const root = parent && parent.orig_key === card.orig_key ? parent : card;
  const blocked = canStartChildren();
  if (blocked) return { ok: false, message: blocked };
  if (listChildren(root.id).some((c) => c.status === "pending" && c.orig_key === root.orig_key)) {
    return { ok: true, message: "Already painting a new version." };
  }
  startJob({ feed: root.feed, parent: root, kind: "version", today });
  return { ok: true };
}

const likeStarting = new Set<string>();

/** "More like this": up to `n` new pairs like this card (idempotent per card). */
export async function startMore(parentId: string, n = 4): Promise<{ ok: boolean; message?: string }> {
  const parent = getCard(parentId);
  if (!parent || parent.status !== "ready") return { ok: false, message: "That painting isn't ready yet." };
  const existing = listChildren(parent.id).filter((c) => c.orig_key !== parent.orig_key).length;
  const want = n - existing;
  if (want <= 0 || likeStarting.has(parent.id)) return { ok: true };
  const blocked = canStartChildren();
  if (blocked) return { ok: false, message: blocked };
  likeStarting.add(parent.id);
  try {
    if (parent.feed !== "museum") {
      const pb = parseJson<Partial<InventedBrief>>(parent.brief, {});
      const base: InventedBrief = {
        title: parent.title,
        era: pb.era ?? parent.after_label.replace(/^after an invented /, "").replace(/ painting$/, ""),
        date: pb.date ?? "",
        medium: pb.medium ?? "oil on canvas",
        aspect: pb.aspect ?? "4:5",
        scene: pb.scene ?? parent.title,
        cast: pb.cast ?? ["cat", "chef"],
      };
      const got = await writeLikeBriefs(base, want, recentTitles(80), parent.feed === "modern");
      for (const b of got.slice(0, want)) startJob({ feed: parent.feed, parent, kind: "like", brief: b });
    } else {
      const pb = parseJson<{ artist?: string; creatorQid?: string }>(parent.brief, {});
      const artist = pb.artist ?? parent.after_label.replace(/^after /, "");
      const used = usedMuseumRefs();
      let cands: MuseumCandidate[] = await catalogCandidates({ exclude: used, limit: 16, creatorQid: pb.creatorQid, creatorName: pb.creatorQid ? undefined : artist }).catch(() => [] as MuseumCandidate[]);
      if (cands.length < want) cands = cands.concat(await catalogCandidates({ exclude: used, limit: 16 }).catch(() => [] as MuseumCandidate[]));
      const kept = await judgeMuseum(cands.slice(0, 20));
      for (const c of kept.slice(0, want)) startJob({ feed: "museum", parent, kind: "like", candidate: c });
    }
    return { ok: true };
  } finally {
    likeStarting.delete(parent.id);
  }
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
      const src = await getObject(card.her_key as string);
      const out = await recolor(src, recolorPrompt(PALETTES[palette].text));
      addCost(cardId, FEED_PRICE_USD.recolor);
      const key = `feed/${cardId}/var-${palette}.jpg`;
      await put(key, out);
      const vars = parseJson<Record<string, string>>(getCard(cardId)?.variants, {});
      vars[palette] = key;
      updateCard(cardId, { variants: JSON.stringify(vars) });
      return key;
    })().finally(() => variantJobs.delete(jobKey));
    variantJobs.set(jobKey, job);
  }
  return job;
}

// ------------------------------------------------------------ Matisse checkbox

/** Variant key under which a card's Matisse painting is stored (variants JSON). */
export const MATISSE_KEY = "painter:matisse";

/**
 * The R2 key of this card's ORIGINAL painted as if by Matisse, painting it on
 * first view while the checkbox is on (~2 min, GPT Image 2 cast with three of
 * his paintings). Concurrent requests for the same card share one job.
 */
export async function ensureMatisse(cardId: string): Promise<string> {
  const card = getCard(cardId);
  if (!card || card.status !== "ready" || !card.orig_key) throw new Error("card not ready");
  const existing = parseJson<Record<string, string>>(card.variants, {});
  if (existing[MATISSE_KEY]) return existing[MATISSE_KEY];
  if (monthlyUsageUsd() >= monthlyCap()) throw new Error("monthly_cap_reached");
  if (painterLocked()) throw new Error("painter_paused");
  const jobKey = `${cardId}:matisse`;
  let job = variantJobs.get(jobKey);
  if (!job) {
    job = (async () => {
      const src = await getObject(card.orig_key as string);
      const refs = await matisseImages(pickMatisseRefs(cardId));
      const out = await paintHers(src, refs, matissePrompt(), "matisse version");
      addCost(cardId, FEED_PRICE_USD.hers);
      const key = `feed/${cardId}/matisse.jpg`;
      await put(key, out);
      const vars = parseJson<Record<string, string>>(getCard(cardId)?.variants, {});
      vars[MATISSE_KEY] = key;
      updateCard(cardId, { variants: JSON.stringify(vars) });
      return key;
    })().finally(() => variantJobs.delete(jobKey));
    variantJobs.set(jobKey, job);
  }
  return job;
}

/** Why a card's last Matisse painting failed, so polling doesn't restart a paid job forever. */
const matisseErrors = new Map<string, { msg: string; at: number }>();

/**
 * Non-blocking form of ensureMatisse for the route: a painting takes about two
 * minutes, longer than an iPad should hold one request open, so the page
 * polls. Starts the job if needed; a failure is reported for 10 minutes before
 * the next poll may try again.
 */
export function matisseStatus(cardId: string): { key: string } | { painting: true } | { error: string } {
  const card = getCard(cardId);
  if (!card || card.status !== "ready" || !card.orig_key) return { error: "card not ready" };
  const key = parseJson<Record<string, string>>(card.variants, {})[MATISSE_KEY];
  if (key) return { key };
  const err = matisseErrors.get(cardId);
  if (err && Date.now() - err.at < 10 * 60_000) return { error: err.msg };
  if (!variantJobs.has(`${cardId}:matisse`)) {
    matisseErrors.delete(cardId);
    ensureMatisse(cardId).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[feed] matisse ${cardId} failed:`, msg);
      notePainterFailure(msg);
      matisseErrors.set(cardId, { msg, at: Date.now() });
    });
  }
  return { painting: true };
}

// ------------------------------------------------------------ v7.3 repaint

/** Variants key holding a card's pre-v7.3 her version, so a repaint can be undone. */
export const PREVIOUS_HER_KEY = "v72:her";

const repaintRun = { running: false, total: 0, done: 0, failed: 0, lastError: "" };

export function repaintStatus(): typeof repaintRun {
  return { ...repaintRun };
}

/**
 * Repaint these cards' her versions in the v7.3 style, six at a time, in the
 * background (Zuzi: the old ones "don't look like good paintings"). Keeps the
 * card's palette, cast and "today" choice, and its place in the feed; the old
 * image stays in R2 under variants[PREVIOUS_HER_KEY]. Palette dots made from
 * the old image are dropped so they repaint from the new one. Safe to rerun:
 * already-repainted and hearted cards are skipped.
 */
export function startRepaint(ids: string[]): boolean {
  if (repaintRun.running) return false;
  Object.assign(repaintRun, { running: true, total: ids.length, done: 0, failed: 0, lastError: "" });
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await repaintOne(id);
        repaintRun.done++;
      } catch (e) {
        repaintRun.failed++;
        repaintRun.lastError = e instanceof Error ? e.message : String(e);
        notePainterFailure(repaintRun.lastError);
        console.error(`[feed] repaint ${id} failed:`, repaintRun.lastError);
      }
    }
  };
  void Promise.all(Array.from({ length: 6 }, worker)).finally(() => {
    repaintRun.running = false;
  });
  return true;
}

async function repaintOne(id: string): Promise<void> {
  const card = getCard(id);
  if (!card || card.status !== "ready" || !card.orig_key || !card.her_key || card.saved_at) return;
  const vars = parseJson<Record<string, string>>(card.variants, {});
  if (vars[PREVIOUS_HER_KEY]) return;
  if (monthlyUsageUsd() >= monthlyCap()) throw new Error("monthly_cap_reached");
  const pb = parseJson<{ cast?: string[]; asMade?: string; today?: boolean }>(card.brief, {});
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const palette: PaletteKey = isPaletteKey(pb.asMade) ? pb.asMade : HER_PALETTES[h % HER_PALETTES.length];
  const text = PALETTES[palette].text;
  const prompt = pb.today ? hersTodayPrompt(text) : card.feed === "museum" ? hersFromMuseumPrompt(text) : hersFromInventedPrompt(text);
  const hers = await paintHers(await getObject(card.orig_key), await castImages(pb.cast ?? ["cat", "chef"]), prompt);
  addCost(id, FEED_PRICE_USD.hers);
  const key = `feed/${id}/her-v73.jpg`;
  await put(key, hers);
  const hd = await dims(hers);
  const fresh = parseJson<Record<string, string>>(getCard(id)?.variants, {});
  const kept: Record<string, string> = { [PREVIOUS_HER_KEY]: card.her_key };
  if (fresh[MATISSE_KEY]) kept[MATISSE_KEY] = fresh[MATISSE_KEY];
  updateCard(id, { her_key: key, her_w: hd.w, her_h: hd.h, variants: JSON.stringify(kept) });
}
