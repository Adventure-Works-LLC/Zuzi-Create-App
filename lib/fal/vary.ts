/**
 * Sketch Vary provider — the fal-hosted FLUX LoRA of Zuzi's hand.
 *
 * This is the ONLY non-Gemini generation engine in the app (AGENTS.md §16).
 * A sketch_vary iteration runs the source sketch through img2img on
 * FLUX.1-dev + the ZUZQ style LoRA that was trained on her own drawings
 * (July 2026, fal-ai/flux-lora-fast-training, 10 curated originals).
 * The product operation is fixed: settle/perfect the drawing in her own
 * hand, add NOTHING new. Variation size is controlled by the img2img
 * denoise strength, not by prompt changes.
 *
 * Env (both required at call time, never at module load — AGENTS.md §9):
 *   FAL_KEY        — fal.ai API credential.
 *   ZUZQ_LORA_URL  — the trained LoRA weights URL (fal CDN). Not
 *                    committed: the URL is unguessable and grants use of
 *                    her style — treat like a secret. The weights file
 *                    itself is also saved locally at data/zuzq-lora-v1
 *                    .safetensors (gitignored) and re-downloadable from
 *                    the fal dashboard.
 *
 * VARY_PROMPT is LOCKED — byte-identical to the lab prompt that produced
 * the approved Gemini-vs-LoRA board. It is deliberately thin: with the
 * style in the weights, the prompt only names the operation. Canary in
 * scripts/check-prompts.ts; update both together or the build fails.
 */

import { Buffer } from "node:buffer";
import sharp from "sharp";

import { callWithRetry } from "../gemini/callWithRetry";
import { enrichFalError } from "./engines";
import { VARY_PROMPT, type VaryStrength } from "./varyConstants";

// Locked prompt + strength set live in ./varyConstants (dependency-free
// so client components can import them); re-exported here so server
// code has one import site.
export {
  VARY_PROMPT,
  VARY_STRENGTHS,
  isVaryStrength,
  varyStrengthLabel,
  type VaryStrength,
} from "./varyConstants";

/** fal endpoint. img2img keeps the input's dimensions (snapped to the
 *  model's grid), so the §3 output-aspect==input-aspect invariant is
 *  satisfied by the engine itself — there is no aspect config to pass. */
const FAL_VARY_ENDPOINT = "fal-ai/flux-lora/image-to-image";

/** Long-edge cap for the img2img input. FLUX.1-dev is a ~1MP-native
 *  model; sending the full 2048px upload wastes payload and gets
 *  downscaled server-side anyway. 1344 keeps ~1MP at her typical 3:4
 *  while preserving aspect exactly. */
const VARY_INPUT_LONG_EDGE_PX = 1344;

/** Lab-validated sampler settings — keep in lockstep with what produced
 *  the approved board. */
const VARY_INFERENCE_STEPS = 32;

/** Wall-clock guard per fal call. fal.subscribe polls a queue; a stuck
 *  queue would otherwise hold the tile 'pending' until the next boot
 *  sweep. A timed-out call may still complete (and charge) server-side —
 *  that's the same accepted cost floor as Style Explore's Stop button
 *  (AGENTS.md §13). */
const VARY_CALL_TIMEOUT_MS = 180_000;

/**
 * Both env vars, checked at request time by POST /api/iterate so a
 * misconfigured deploy rejects vary submissions with a clean 503
 * instead of inserting an iteration whose every tile fails in the
 * worker.
 */
export function varyConfigMissing(): string[] {
  const missing: string[] = [];
  if (!process.env.FAL_KEY) missing.push("FAL_KEY");
  if (!process.env.ZUZQ_LORA_URL) missing.push("ZUZQ_LORA_URL");
  return missing;
}

// Lazy singleton per AGENTS.md §9 — importing this module must be a
// no-op (Next's build-time page-data collection imports every route
// handler's dependency graph). fal.config is process-global; we call it
// once, on first use, inside the request path.
let _falConfigured = false;
async function falClient() {
  const { fal } = await import("@fal-ai/client");
  if (!_falConfigured) {
    const key = process.env.FAL_KEY;
    if (!key) {
      throw new Error(
        "FAL_KEY missing. Set it in .env (local) / Railway env vars — sketch_vary cannot run without it.",
      );
    }
    fal.config({ credentials: key });
    _falConfigured = true;
  }
  return fal;
}

function loraUrl(): string {
  const url = process.env.ZUZQ_LORA_URL;
  if (!url) {
    throw new Error(
      "ZUZQ_LORA_URL missing. Set it to the trained LoRA weights URL (see fal dashboard or lib/fal/vary.ts header).",
    );
  }
  return url;
}

interface FalImageOut {
  url?: string;
}
interface FalVaryOutput {
  images?: FalImageOut[];
  has_nsfw_concepts?: boolean[];
}

/**
 * Run ONE vary generation: source sketch bytes in, finished jpeg bytes
 * out. Called once per tile by the worker (N parallel calls per
 * iteration — mirrors the Gemini per-tile call model; fal seeds each
 * call randomly so parallel calls at the same strength differ).
 *
 * The input is resized (long edge ≤ 1344, aspect preserved) and sent as
 * a data URI — nothing is persisted to fal storage for inference.
 */
export async function generateVaryImage(
  sourceBytes: Buffer,
  strength: VaryStrength,
  label: string,
): Promise<Buffer> {
  const fal = await falClient();
  const lora = loraUrl();

  const input = await sharp(sourceBytes)
    .resize(VARY_INPUT_LONG_EDGE_PX, VARY_INPUT_LONG_EDGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer();
  const imageDataUri = `data:image/jpeg;base64,${input.toString("base64")}`;

  // 1 initial + 1 retry only (attempts: 2). Gemini's default 4 attempts
  // is wrong here: a timed-out fal call may still complete and charge,
  // so each extra retry raises the worst-case cost floor.
  const result = await callWithRetry(
    () =>
      withTimeout(
        fal
          .subscribe(FAL_VARY_ENDPOINT, {
            input: {
              image_url: imageDataUri,
              prompt: VARY_PROMPT,
              loras: [{ path: lora, scale: 1.0 }],
              strength,
              num_images: 1,
              num_inference_steps: VARY_INFERENCE_STEPS,
              output_format: "jpeg",
              enable_safety_checker: true,
            },
            logs: false,
          })
          // Surface fal's body.detail (content_policy_violation → the
          // 'safety'/blocked path; everything else keeps its detail
          // instead of a bare "Unprocessable Entity"). See
          // enrichFalError in lib/fal/engines.ts.
          .catch((e) => {
            throw enrichFalError(e, "vary", label);
          }),
        VARY_CALL_TIMEOUT_MS,
        label,
      ),
    { label, attempts: 2 },
  );

  const data = (result as { data?: FalVaryOutput }).data;
  const img = data?.images?.[0];
  if (!img?.url) {
    throw new Error(
      `fal vary returned no image (${label}) — response had ${data?.images?.length ?? 0} images`,
    );
  }
  // The checker doesn't block output on this endpoint — it annotates.
  // Her sketches never trip it legitimately, so treat a flag as the
  // moral equivalent of a Gemini safety block: the message routes
  // classifyError → 'safety' → tile status 'blocked' in the worker.
  if (data?.has_nsfw_concepts?.[0] === true) {
    throw new Error(
      `fal safety checker flagged the output (${label}) — blocked by safety filter`,
    );
  }

  const resp = await fetch(img.url);
  if (!resp.ok) {
    throw new Error(
      `fal output fetch failed (${label}): HTTP ${resp.status} for result URL`,
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}

/** Reject-on-timer wrapper. The underlying fal poll loop keeps running
 *  when we bail (no cancellation API on subscribe) — acceptable: the
 *  worker marks the tile failed and moves on; a late completion is
 *  discarded with the promise. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`fal vary call timeout after ${ms}ms (${label})`)),
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
