/**
 * Per-image and per-grid USD pricing for Gemini image generation.
 *
 * Verified against https://ai.google.dev/gemini-api/docs/pricing on 2026-04-22 (the
 * page's last-updated date). All figures are STANDARD TIER paid pricing. Batch tier is
 * approximately half but we don't use it — both smoke and the production worker fire
 * synchronous parallel calls, not batch.
 *
 * If Google updates pricing:
 *   1. Update the table below.
 *   2. Update the verification date stamp in this header.
 *   3. Update the matrix in AGENTS.md §4.
 *
 * This is the ONLY file in the repo that names a pricing constant. Cap checks
 * (`/api/iterate` cap-on-submit, `/api/usage` totals) and UI cost annotations all read
 * from here.
 */

/**
 * User-pickable engine tiers (the InputBar pill). flash/pro run on
 * Gemini; flux2max/seedream run on fal (v5.4, AGENTS.md §17). The
 * fifth stored tier 'flux' (the Vary LoRA) is mode-forced, never
 * picked, and priced via costForVary below.
 */
export type ModelTier = "flash" | "pro" | "flux2max" | "seedream";
export type Resolution = "1k" | "4k";

const PRICE_PER_IMAGE_USD: Record<ModelTier, Record<Resolution, number>> = {
  // gemini-3.1-flash-image-preview ("Nano Banana 2 Flash")
  flash: { "1k": 0.067, "4k": 0.101 },
  // gemini-3-pro-image-preview ("Nano Banana Pro")
  pro: { "1k": 0.134, "4k": 0.24 },
  // fal-ai/flux-2-max/edit (v5.4) — $0.07 base + ~$0.03/output MP per
  // the July 2026 research pass. '1k' (1440 long edge ≈ 1.3MP) ≈ $0.11,
  // '4k' (2560 ≈ 4.2MP) ≈ $0.19 — both rounded UP so the monthly cap
  // check stays conservative. Re-verify on the fal dashboard if
  // production spend drifts.
  flux2max: { "1k": 0.13, "4k": 0.2 },
  // fal-ai/bytedance/seedream/v5/lite/edit (v5.4) — flat per image
  // (fal lists $0.035 regardless of size up to its cap).
  seedream: { "1k": 0.035, "4k": 0.035 },
};

/**
 * v5 Sketch Vary (AGENTS.md §16) — fal.ai FLUX.1-dev + ZUZQ LoRA,
 * billed per output megapixel (fal-ai/flux-lora: $0.025/MP, min 1MP).
 * Vary outputs are ~1–1.3MP (input long edge capped at 1344px), so
 * $0.035/image is a deliberately conservative projection. Verified
 * against the July 2026 lab runs on the fal billing dashboard; re-check
 * there if production spend drifts from projection. Resolution-
 * independent — the 1K/4K toggle does not apply to vary iterations.
 */
const VARY_PRICE_PER_IMAGE_USD = 0.035;

export function varyPricePerImage(): number {
  return VARY_PRICE_PER_IMAGE_USD;
}

/** Projected (cap-check) AND completed (usage_log) cost for a vary
 *  iteration — same shape as costFor/costForCompletedIteration but
 *  keyed on nothing: vary has one engine, one effective resolution. */
export function costForVary(count: number): number {
  return VARY_PRICE_PER_IMAGE_USD * count;
}

export function pricePerImage(
  tier: ModelTier,
  resolution: Resolution,
): number {
  return PRICE_PER_IMAGE_USD[tier][resolution];
}

/**
 * Projected cost of a Submit before it runs — `pricePerImage × count`. Used by
 * the cap-check on `POST /api/iterate` to refuse over-budget submissions before
 * the worker fires.
 */
export function costFor(
  tier: ModelTier,
  resolution: Resolution,
  count: number,
): number {
  return pricePerImage(tier, resolution) * count;
}

/**
 * Cost for an iteration that completed with `successfulTileCount` tiles. Used by the
 * worker to write `usage_log.cost_usd` based on actual successes (a partial-success
 * iteration shouldn't be billed for the failed tiles' attempts since Gemini doesn't
 * charge for blocked / errored generations).
 */
export function costForCompletedIteration(
  tier: ModelTier,
  resolution: Resolution,
  successfulTileCount: number,
): number {
  return pricePerImage(tier, resolution) * successfulTileCount;
}
