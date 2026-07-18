/**
 * Client-safe constants for the v5.4 alternate engines (AGENTS.md §17):
 * FLUX 2 Max and Seedream 5-Lite as user-pickable tiers in the InputBar
 * pill, alongside Gemini's Flash/Pro. Zero imports — same rule as
 * varyConstants.ts (this file reaches client bundles).
 *
 * These tiers were validated in the July 3 2026 model lab against
 * Zuzi's own favorited (sketch, style) pairs — see the shootout memory
 * + scratchpad boards. Nano Pro remains the default/champion; these are
 * deliberate-choice alternatives (Max: same-price painterly, quota-
 * immune; Seedream: 4×-cheaper, quota-immune). They are NEVER a silent
 * fallback — the user picks them in the pill, and every iteration row
 * is labeled with its engine.
 */

/** User-pickable engine tiers that run on fal instead of Gemini.
 *  ('flux' — the Vary LoRA — is deliberately NOT here: it's forced by
 *  mode='sketch_vary' at the route, never picked in the pill.) */
export const FAL_ENGINE_TIERS = ["flux2max", "seedream"] as const;
export type FalEngineTier = (typeof FAL_ENGINE_TIERS)[number];

export function isFalEngineTier(v: unknown): v is FalEngineTier {
  return v === "flux2max" || v === "seedream";
}

/** Short display strings (IterationRow caption, pill labels). */
export const ENGINE_LABEL: Record<FalEngineTier, string> = {
  flux2max: "flux max",
  seedream: "seedream",
};

/**
 * LOCKED style_explore directive for the fal engines — byte-identical
 * to the lab's PROMPT_ROLE (BFL role-per-image pattern + ComfyUI
 * anti-bleed clause), which is what earned Max and Seedream their
 * picker slots. The Gemini path keeps its own locked
 * STYLE_EXPLORE_DIRECTIVE ("image one / image two" phrasing, Krea-
 * validated); each engine family runs the directive it was validated
 * with. Canary-guarded in scripts/check-prompts.ts.
 */
export const FAL_STYLE_EXPLORE_DIRECTIVE =
  "Take the character and composition from image 1. Take the painting style, brushwork, and color palette from image 2. Render image 1 as a completed painting in image 2's style, preserving image 1's exact character design and shapes. Do not reuse any subject or content from image 2; it is a style reference only.";

/**
 * v5.6 "Her colors" variant for the fal engines — same role-per-image
 * template with the palette reassigned to image 1. Selected when the
 * ExploreSheet's keep-source-colors switch is ON and the tier is
 * flux2max/seedream. Canary-guarded.
 */
export const FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE =
  "Take the character, composition, and color palette from image 1. Take ONLY the painted texture, brushwork, and surface treatment from image 2 — not its colors. Render image 1 as a completed painting with image 2's paint handling, preserving image 1's exact character design, shapes, and colors. Do not reuse any subject, content, or colors from image 2; it is a texture reference only.";
