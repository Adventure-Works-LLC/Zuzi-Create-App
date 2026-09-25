/**
 * v7 Zuzi's Scroll — model calls and museum sourcing (AGENTS.md §18).
 *
 * Engines are chosen on LOOK first (Jeff, Sept 2026: "never sacrifice
 * look" — GPT Image 2.5 was rejected despite being 4x faster):
 *   - invented originals:  gemini-3-pro-image (Nano Banana Pro)
 *   - her version:         fal-ai/gpt-image-2/edit, quality high
 *   - palette recolors:    gemini-3.1-flash-image (Nano Banana 2)
 *   - idea-writer / judge: a Gemini text model (FEED_TEXT_MODEL)
 * Speed is handled by the producer's buffer, never by a cheaper model.
 *
 * Module-load hygiene (AGENTS.md §9): no env reads at top level; clients are
 * lazy. Callers are route handlers / instrumentation on the Node runtime
 * (sharp + R2 in scope — AGENTS.md §2).
 */

import sharp from "sharp";

import { genai } from "@/lib/gemini/client";
import { getObject } from "@/lib/storage/r2";

import { CAST, isCastKey } from "./cast";
import {
  ideaWriterPrompt,
  museumJudgePrompt,
  type InventedBrief,
} from "./prompts";

const ORIGINAL_MODEL = "gemini-3-pro-image";
const RECOLOR_MODEL = "gemini-3.1-flash-image";
const HERS_ENDPOINT = "fal-ai/gpt-image-2/edit";
function textModel(): string {
  return process.env.FEED_TEXT_MODEL || "gemini-3.5-flash";
}

const CALL_TIMEOUT_MS = 300_000;
const UA = "zuzi-studio/1.0 (private single-user app)";

function withTimeout<T>(p: Promise<T>, label: string, ms = CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

let _falConfigured = false;
async function fal() {
  const { fal } = await import("@fal-ai/client");
  if (!_falConfigured) {
    const key = process.env.FAL_KEY;
    if (!key) throw new Error("FAL_KEY missing — the Scroll's her-version renders run on fal.");
    fal.config({ credentials: key });
    _falConfigured = true;
  }
  return fal;
}

const dataUri = (b: Buffer) => "data:image/jpeg;base64," + b.toString("base64");

export async function toJpeg(buf: Buffer, long = 1280, quality = 88): Promise<Buffer> {
  return sharp(buf).rotate().resize(long, long, { fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
}

export async function dims(buf: Buffer): Promise<{ w: number; h: number }> {
  const m = await sharp(buf).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

const GEMINI_ARS: Array<[number, number]> = [[1, 1], [2, 3], [3, 2], [3, 4], [4, 3], [4, 5], [5, 4], [9, 16], [16, 9], [21, 9]];
function nearestAspect(w: number, h: number): string {
  const r = w / h;
  let best = GEMINI_ARS[0];
  for (const a of GEMINI_ARS) if (Math.abs(Math.log(a[0] / a[1] / r)) < Math.abs(Math.log(best[0] / best[1] / r))) best = a;
  return `${best[0]}:${best[1]}`;
}

function outSize(w: number, h: number): { width: number; height: number } {
  const r = Math.min(Math.max(w / h, 0.5), 2);
  const snap = (v: number) => Math.round(v / 16) * 16;
  return r >= 1 ? { width: 1280, height: snap(1280 / r) } : { width: snap(1280 * r), height: 1280 };
}

function geminiImage(res: unknown): Buffer {
  const r = res as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] }; finishReason?: string }[] };
  const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error(`no image returned (${r.candidates?.[0]?.finishReason ?? "unknown"})`);
  return Buffer.from(part.inlineData.data, "base64");
}

// ---------------------------------------------------------------- her cast

const castCache = new Map<string, Buffer>();

/** Her paintings for the given cast keys, resized for input. Missing ones drop out. */
export async function castImages(keys: string[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const k of keys.filter(isCastKey).slice(0, 3)) {
    let b = castCache.get(k);
    if (!b) {
      try {
        b = await toJpeg(await getObject(`inputs/${CAST[k].sourceId}.jpg`));
        castCache.set(k, b);
      } catch (e) {
        console.warn(`[feed] cast ${k} unavailable:`, e instanceof Error ? e.message : e);
        continue;
      }
    }
    out.push(b);
  }
  if (out.length === 0 && !keys.includes("cat")) return castImages(["cat", "chef"]);
  return out;
}

// ---------------------------------------------------------------- painting

export async function paintOriginal(prompt: string, aspect: string): Promise<Buffer> {
  const res = await withTimeout(
    genai().models.generateContent({
      model: ORIGINAL_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { imageConfig: { aspectRatio: aspect, imageSize: "1K" } },
    }),
    "invented original",
  );
  return toJpeg(geminiImage(res), 1280, 90);
}

export async function paintHers(image1: Buffer, cast: Buffer[], prompt: string): Promise<Buffer> {
  const f = await fal();
  const { w, h } = await dims(image1);
  const urls = [dataUri(await toJpeg(image1)), ...cast.map(dataUri)];
  const r = (await withTimeout(
    f.subscribe(HERS_ENDPOINT, {
      input: { prompt, image_urls: urls, image_size: outSize(w, h), quality: "high", output_format: "jpeg" },
    }),
    "her version",
  )) as { data?: { images?: { url?: string }[] } };
  const url = r.data?.images?.[0]?.url;
  if (!url) throw new Error("her version: no image returned");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`her version download ${resp.status}`);
  return toJpeg(Buffer.from(await resp.arrayBuffer()), 1280, 88);
}

export async function recolor(src: Buffer, prompt: string): Promise<Buffer> {
  const { w, h } = await dims(src);
  const res = await withTimeout(
    genai().models.generateContent({
      model: RECOLOR_MODEL,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: (await toJpeg(src)).toString("base64") } }, { text: prompt }] }],
      config: { imageConfig: { aspectRatio: nearestAspect(w, h), imageSize: "1K" } },
    }),
    "recolor",
    120_000,
  );
  return toJpeg(geminiImage(res), 1280, 88);
}

// ---------------------------------------------------------------- ideas

function parseJsonArray(text: string): unknown[] {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e < s) throw new Error("no JSON array in model reply");
  const v = JSON.parse(text.slice(s, e + 1));
  if (!Array.isArray(v)) throw new Error("model reply is not an array");
  return v;
}

export async function writeBriefs(n: number, avoidTitles: string[], modern = false): Promise<InventedBrief[]> {
  const res = await withTimeout(
    genai().models.generateContent({
      model: textModel(),
      contents: [{ role: "user", parts: [{ text: ideaWriterPrompt(n, avoidTitles, modern) }] }],
      config: { responseMimeType: "application/json", temperature: 1.0 },
    }),
    "idea-writer",
    120_000,
  );
  const out: InventedBrief[] = [];
  for (const x of parseJsonArray(res.text ?? "")) {
    const b = x as Partial<InventedBrief>;
    if (!b.title || !b.era || !b.scene) continue;
    out.push({
      title: String(b.title).slice(0, 120),
      era: String(b.era).slice(0, 80),
      date: String(b.date ?? "").slice(0, 40),
      medium: String(b.medium ?? "oil on canvas").slice(0, 80),
      aspect: b.aspect === "5:4" ? "5:4" : "4:5",
      scene: String(b.scene).slice(0, 600),
      cast: (Array.isArray(b.cast) ? b.cast : []).filter(isCastKey).slice(0, 3),
    });
  }
  return out;
}

// ---------------------------------------------------------------- museum

export interface MuseumCandidate {
  ref: string; // 'wd-Q123' | 'aic-123' | 'met-456'
  title: string;
  artist: string;
  date: string;
  museum: string;
  page: string;
  image: string; // full-ish image URL
  thumb: string;
  creatorQid?: string; // Wikidata artist, for "More like this"
}

const MOTIFS = ["asleep", "sleeping", "napping", "café", "tavern", "drinking", "wine", "horse", "horses", "rider", "kitchen", "cook", "peeling", "picnic", "harvest", "cat", "bar", "dance", "dancer", "night", "boots", "waiter", "reading", "bath", "music", "singer", "table", "breakfast", "garden", "stable"];

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/** Public-domain paintings from the Art Institute of Chicago and the Met for a few random motifs. */
export async function museumCandidates(exclude: Set<string>, motifCount = 2): Promise<MuseumCandidate[]> {
  const motifs = [...MOTIFS].sort(() => Math.random() - 0.5).slice(0, motifCount);
  const out: MuseumCandidate[] = [];
  for (const q of motifs) {
    try {
      const d = (await getJson(
        `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&query[term][is_public_domain]=true&fields=id,title,artist_title,date_display,image_id,classification_title&limit=30`,
      )) as { data?: { id: number; title: string; artist_title: string | null; date_display: string; image_id: string | null; classification_title: string | null }[] };
      for (const a of d.data ?? []) {
        const ref = `aic-${a.id}`;
        if (!a.image_id || exclude.has(ref) || !/painting/i.test(a.classification_title ?? "")) continue;
        out.push({ ref, title: a.title, artist: a.artist_title ?? "Unknown artist", date: a.date_display ?? "", museum: "Art Institute of Chicago", page: `https://www.artic.edu/artworks/${a.id}`, image: `https://www.artic.edu/iiif/2/${a.image_id}/full/1200,/0/default.jpg`, thumb: `https://www.artic.edu/iiif/2/${a.image_id}/full/400,/0/default.jpg` });
      }
    } catch (e) { console.warn("[feed] AIC search failed:", e instanceof Error ? e.message : e); }
    try {
      const s = (await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&medium=Paintings&q=${encodeURIComponent(q)}`)) as { objectIDs?: number[] | null };
      const ids = (s.objectIDs ?? []).sort(() => Math.random() - 0.5).slice(0, 14);
      for (const id of ids) {
        const ref = `met-${id}`;
        if (exclude.has(ref)) continue;
        try {
          const o = (await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)) as { isPublicDomain?: boolean; primaryImage?: string; primaryImageSmall?: string; title?: string; artistDisplayName?: string; objectDate?: string; objectURL?: string };
          if (!o.isPublicDomain || !o.primaryImageSmall || !o.primaryImage) continue;
          out.push({ ref, title: o.title ?? "Untitled", artist: o.artistDisplayName || "Unknown artist", date: o.objectDate ?? "", museum: "The Met", page: o.objectURL ?? "", image: o.primaryImage, thumb: o.primaryImageSmall });
        } catch { /* skip one object */ }
      }
    } catch (e) { console.warn("[feed] Met search failed:", e instanceof Error ? e.message : e); }
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)));
}

export async function fetchImage(url: string): Promise<Buffer> {
  const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA } }), "museum image", 60_000);
  if (!r.ok) throw new Error(`museum image ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export interface JudgedCandidate extends MuseumCandidate {
  cast: string[];
  rhyme: string;
}

/** Ask the judge which candidates are strong starting points for her. Batches of up to 10. */
export async function judgeMuseum(cands: MuseumCandidate[]): Promise<JudgedCandidate[]> {
  const kept: JudgedCandidate[] = [];
  for (let i = 0; i < cands.length; i += 10) {
    const batch = cands.slice(i, i + 10);
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [{ text: museumJudgePrompt(batch.length) }];
    const usable: MuseumCandidate[] = [];
    for (const c of batch) {
      try {
        const t = await sharp(await fetchImage(c.thumb)).resize(384, 384, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
        parts.push({ text: `Image ${usable.length}: "${c.title}" by ${c.artist}` });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: t.toString("base64") } });
        usable.push(c);
      } catch { /* unreachable thumbnail — skip */ }
    }
    if (usable.length === 0) continue;
    try {
      const res = await withTimeout(
        genai().models.generateContent({ model: textModel(), contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", temperature: 0.2 } }),
        "museum judge",
        120_000,
      );
      for (const x of parseJsonArray(res.text ?? "")) {
        const v = x as { i?: number; keep?: boolean; cast?: unknown[]; rhyme?: string };
        const c = typeof v.i === "number" ? usable[v.i] : undefined;
        if (!c || !v.keep) continue;
        const cast = (Array.isArray(v.cast) ? v.cast : []).filter(isCastKey).slice(0, 3) as string[];
        kept.push({ ...c, cast: cast.length ? cast : ["cat"], rhyme: String(v.rhyme ?? "").slice(0, 80) });
      }
    } catch (e) { console.warn("[feed] museum judge failed:", e instanceof Error ? e.message : e); }
  }
  return kept;
}

// ---------------------------------------------------------------- blue-chip catalog (Wikidata)

/**
 * The museum feed's main catalog: public-domain paintings with images on
 * Wikimedia Commons, held by the great museums, by artists famous enough to
 * have Wikipedia articles in 70+ languages (the "blue chip" filter; ~10k+
 * paintings). Commons reproductions of public-domain 2D works are public
 * domain. Queried live (free, no key); ~15–25s per query, so only the
 * background refill calls it.
 */
const MUSEUMS: Record<string, string> = {
  Q160236: "The Met",
  Q510324: "Philadelphia Museum of Art",
  Q808462: "Barnes Foundation",
  Q239303: "Art Institute of Chicago",
  Q214867: "National Gallery of Art",
  Q23402: "Musée d'Orsay",
  Q180788: "National Gallery, London",
  Q188740: "MoMA",
  Q19675: "Louvre",
  Q190804: "Rijksmuseum",
  Q160112: "Prado",
  Q51252: "Uffizi",
  Q95569: "Kunsthistorisches Museum",
  Q224124: "Van Gogh Museum",
  Q1051928: "Kröller-Müller Museum",
  Q1134541: "Courtauld Gallery",
  Q49133: "Museum of Fine Arts, Boston",
  Q1099141: "Clark Art Institute",
  Q1270597: "Phillips Collection",
  Q657415: "Cleveland Museum of Art",
  Q154568: "Alte Pinakothek",
  Q170152: "Neue Pinakothek",
  Q163804: "Städel",
  Q430682: "Tate",
  Q536705: "Musée de l'Orangerie",
};

async function sparql(query: string): Promise<Record<string, { value: string }>[]> {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA + " (jashbrook@gmail.com)", Accept: "application/sparql-results+json" } }), "wikidata", 70_000);
  if (!r.ok) throw new Error(`wikidata ${r.status}`);
  const j = (await r.json()) as { results?: { bindings?: Record<string, { value: string }>[] } };
  return j.results?.bindings ?? [];
}

/**
 * Random blue-chip public-domain paintings from the museums above — or, for
 * "More like this", more by one artist (any museum).
 */
export async function catalogCandidates(opts: { exclude: Set<string>; limit?: number; creatorQid?: string; creatorName?: string }): Promise<MuseumCandidate[]> {
  const limit = opts.limit ?? 40;
  const seed = Math.random().toString(36).slice(2);
  const museums = Object.keys(MUSEUMS).map((q) => `wd:${q}`).join(" ");
  const creator = opts.creatorQid
    ? `BIND(wd:${opts.creatorQid} AS ?creator)`
    : opts.creatorName
      ? `?creator rdfs:label ${JSON.stringify(opts.creatorName)}@en .`
      : "";
  const museumClause = creator ? "" : `VALUES ?museum { ${museums} } ?p wdt:P195 ?museum .`;
  const q = `SELECT ?p ?title ?creator ?creatorLabel ?museum ?inception ?img WHERE {
  ${creator}
  ${museumClause}
  ?p wdt:P31 wd:Q3305213 ; wdt:P18 ?img ; wdt:P6216 wd:Q19652 ; wdt:P170 ?creator .
  ${creator ? "OPTIONAL { ?p wdt:P195 ?museum . }" : "?creator wikibase:sitelinks ?sl . FILTER(?sl >= 70)"}
  ?p rdfs:label ?title . FILTER(LANG(?title) = "en")
  ?creator rdfs:label ?creatorLabel . FILTER(LANG(?creatorLabel) = "en")
  OPTIONAL { ?p wdt:P571 ?inception . }
} ORDER BY MD5(CONCAT(STR(?p), "${seed}")) LIMIT ${limit * 2}`;
  const rows = await sparql(q);
  const out: MuseumCandidate[] = [];
  const seen = new Set<string>();
  for (const b of rows) {
    const qid = b.p.value.split("/").pop() as string;
    const ref = `wd-${qid}`;
    if (seen.has(ref) || opts.exclude.has(ref)) continue;
    seen.add(ref);
    const file = b.img.value.replace(/^http:/, "https:");
    const museumQid = b.museum?.value.split("/").pop() ?? "";
    const year = b.inception?.value ? b.inception.value.slice(0, 4).replace(/^\+/, "") : "";
    out.push({
      ref,
      title: b.title.value,
      artist: b.creatorLabel.value,
      date: year && /^\d{3,4}$/.test(year) ? year : "",
      museum: MUSEUMS[museumQid] ?? "a museum collection",
      page: `https://www.wikidata.org/wiki/${qid}`,
      image: `${file}?width=1400`,
      thumb: `${file}?width=400`,
      creatorQid: b.creator.value.split("/").pop(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- "More like this" ideas

export async function writeLikeBriefs(parent: InventedBrief, n: number, avoidTitles: string[], modern = false): Promise<InventedBrief[]> {
  const prompt = `${ideaWriterPrompt(n, avoidTitles, modern)}

IMPORTANT — these are "more like this" for one brief she loved. Every new brief must feel like a sibling of it: the same era and medium (or a close neighbor), the same kind of subject and mood, and the same cast keys (${parent.cast.join(", ") || "any"}), but a genuinely new scene. The brief she loved:
${JSON.stringify(parent)}`;
  const res = await withTimeout(
    genai().models.generateContent({
      model: textModel(),
      contents: [{ role: "user", parts: [{ text: prompt.replace("use a different era for each brief", "stay close to the loved brief's era") }] }],
      config: { responseMimeType: "application/json", temperature: 1.0 },
    }),
    "idea-writer (more like this)",
    120_000,
  );
  const out: InventedBrief[] = [];
  for (const x of parseJsonArray(res.text ?? "")) {
    const b = x as Partial<InventedBrief>;
    if (!b.title || !b.era || !b.scene) continue;
    out.push({
      title: String(b.title).slice(0, 120),
      era: String(b.era).slice(0, 80),
      date: String(b.date ?? "").slice(0, 40),
      medium: String(b.medium ?? parent.medium).slice(0, 80),
      aspect: b.aspect === "5:4" ? "5:4" : "4:5",
      scene: String(b.scene).slice(0, 600),
      cast: (Array.isArray(b.cast) ? b.cast : parent.cast).filter(isCastKey).slice(0, 3),
    });
  }
  return out;
}
