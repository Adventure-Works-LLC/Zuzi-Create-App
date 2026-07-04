/**
 * v5.4 alternate-engine provider (AGENTS.md §17) — runs style_explore /
 * prompt / style_blend iterations on FLUX 2 Max or Seedream 5-Lite via
 * fal, when the user picks those tiers in the InputBar pill.
 *
 * Same hygiene rules as lib/fal/vary.ts:
 *   - lazy fal client (§9 — module load reads no env)
 *   - data-URI inputs (nothing persisted to fal storage)
 *   - callWithRetry with attempts:2 (a timed-out call may still
 *     complete and charge — keep the worst-case cost floor low)
 *   - 180s wall-clock guard per call
 *   - safety-checker flag → error message containing "blocked by
 *     safety" so classifyError routes it to tile status 'blocked'
 *
 * §3 aspect invariant: both endpoints accept an exact
 * `image_size: {width, height}` object (schema-verified July 4 2026,
 * max 14142/side) — `falImageSize` converts the iteration's target
 * ratio into explicit pixels, so output aspect == source aspect with
 * no prompt-text dependence.
 */

import { Buffer } from "node:buffer";

import { callWithRetry } from "../gemini/callWithRetry";
import { type FalEngineTier } from "./engineConstants";

export { FAL_ENGINE_TIERS, isFalEngineTier } from "./engineConstants";

const ENGINE_ENDPOINT: Record<FalEngineTier, string> = {
  flux2max: "fal-ai/flux-2-max/edit",
  seedream: "fal-ai/bytedance/seedream/v5/lite/edit",
};

/** Long-edge px per resolution toggle. '1k' matches the Vary cap
 *  (~1.3MP at 4:5); '4k' is a moderate 2560 — Max bills per output MP,
 *  so true 4096-edge output would silently double its price. */
const LONG_EDGE_PX: Record<"1k" | "4k", number> = { "1k": 1440, "4k": 2560 };

/** Exact pixel dims for a "W:H" ratio at the tier's long edge, snapped
 *  to multiples of 16 (diffusion-friendly; both endpoints accept any
 *  int but 16-multiples avoid internal rounding drift).
 *
 *  Verified July 4 2026: Max returns the requested pixels exactly
 *  (1152×1440 → 1152×1440); Seedream floors to its native size class
 *  but preserves the requested RATIO exactly (1152×1440 → 1920×2400).
 *  §3's invariant is about aspect, not absolute pixels — both comply.
 *  Seedream's price is flat, so its upsizing costs nothing. */
export function falImageSize(
  aspectRatio: string,
  resolution: "1k" | "4k",
): { width: number; height: number } {
  const m = /^(\d+):(\d+)$/.exec(aspectRatio);
  const w = m ? parseInt(m[1], 10) : 1;
  const h = m ? parseInt(m[2], 10) : 1;
  const long = LONG_EDGE_PX[resolution];
  const snap = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  if (w >= h) {
    return { width: snap(long), height: snap((long * h) / w) };
  }
  return { width: snap((long * w) / h), height: snap(long) };
}

let _falConfigured = false;
async function falClient() {
  const { fal } = await import("@fal-ai/client");
  if (!_falConfigured) {
    const key = process.env.FAL_KEY;
    if (!key) {
      throw new Error(
        "FAL_KEY missing. Set it in .env (local) / Railway env vars — the Max/Seedream tiers cannot run without it.",
      );
    }
    fal.config({ credentials: key });
    _falConfigured = true;
  }
  return fal;
}

/** Route-level fail-fast: the fal engines need only FAL_KEY (no LoRA
 *  URL — that's Vary's extra requirement). */
export function falEngineConfigMissing(): string[] {
  return process.env.FAL_KEY ? [] : ["FAL_KEY"];
}

interface FalImageOut {
  url?: string;
}
interface FalEditOutput {
  images?: FalImageOut[];
  has_nsfw_concepts?: boolean[];
}

const ENGINE_CALL_TIMEOUT_MS = 180_000;

/**
 * One engine generation: ordered input images (same order contract as
 * the Gemini parts array — sketch first, style second / blend tiles in
 * selection order), directive text, exact output size. Returns raw
 * image bytes.
 */
export async function generateFalEngineImage(
  tier: FalEngineTier,
  /** Ordered base64 JPEG payloads — same composition/order contract as
   *  the Gemini parts array (the worker already holds base64 strings;
   *  no Buffer round-trip needed). */
  imageBase64s: string[],
  prompt: string,
  size: { width: number; height: number },
  label: string,
): Promise<Buffer> {
  const fal = await falClient();
  const image_urls = imageBase64s.map(
    (b64) => `data:image/jpeg;base64,${b64}`,
  );

  const result = await callWithRetry(
    () =>
      withTimeout(
        fal.subscribe(ENGINE_ENDPOINT[tier], {
          input: {
            prompt,
            image_urls,
            image_size: size,
            num_images: 1,
            enable_safety_checker: true,
          },
          logs: false,
        }),
        ENGINE_CALL_TIMEOUT_MS,
        label,
      ),
    { label, attempts: 2 },
  );

  const data = (result as { data?: FalEditOutput }).data;
  const img = data?.images?.[0];
  if (!img?.url) {
    throw new Error(
      `fal ${tier} returned no image (${label}) — response had ${data?.images?.length ?? 0} images`,
    );
  }
  if (data?.has_nsfw_concepts?.[0] === true) {
    throw new Error(
      `fal ${tier} safety checker flagged the output (${label}) — blocked by safety filter`,
    );
  }
  const resp = await fetch(img.url);
  if (!resp.ok) {
    throw new Error(
      `fal ${tier} output fetch failed (${label}): HTTP ${resp.status}`,
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(`fal engine call timeout after ${ms}ms (${label})`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
