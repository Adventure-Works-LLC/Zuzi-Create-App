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

export type ModelTier = "flash" | "pro";
export type Resolution = "1k" | "4k";

const PRICE_PER_IMAGE_USD: Record<ModelTier, Record<Resolution, number>> = {
  // gemini-3.1-flash-image-preview ("Nano Banana 2 Flash")
  flash: { "1k": 0.067, "4k": 0.101 },
  // gemini-3-pro-image-preview ("Nano Banana Pro")
  pro: { "1k": 0.134, "4k": 0.24 },
};

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
