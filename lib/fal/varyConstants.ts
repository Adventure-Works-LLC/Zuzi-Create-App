/**
 * Client-safe Sketch Vary constants (AGENTS.md §16).
 *
 * Split from lib/fal/vary.ts because that module imports sharp (a
 * native module) and the fal SDK — neither can enter a client bundle.
 * UI components import from HERE; server code can import either module
 * (vary.ts re-exports these). No imports at all in this file — keep it
 * that way.
 */

/**
 * Locked operation directive sent with every vary call. Byte-identical
 * to the lab prompt that produced the approved Gemini-vs-LoRA board
 * (July 2026). With her hand living in the LoRA weights, the prompt
 * only names the operation: settle/perfect, add NOTHING new. Canary-
 * guarded in scripts/check-prompts.ts — update both together or the
 * build fails.
 */
export const VARY_PROMPT =
  "ZUZQ style rough sketch. The same drawing redrawn by the same hand: settle the composition, commit the marks with confidence, keep every element exactly where it is. Add nothing new. Keep it just as rough, wonky, and unfinished.";

/**
 * The closed strength set — img2img denoise strengths validated in the
 * July 2026 strength sweep:
 *   0.45 — "perfect what she did": same drawing, settled.
 *   0.60 — takes liberties, but only inside her vocabulary of marks.
 *   0.75 — free-ranges her world; new drawing that still reads as hers.
 * The route accepts exactly these three values (a free float would make
 * cost/behavior unpredictable and untestable).
 */
export const VARY_STRENGTHS = [0.45, 0.6, 0.75] as const;
export type VaryStrength = (typeof VARY_STRENGTHS)[number];

export function isVaryStrength(v: unknown): v is VaryStrength {
  return typeof v === "number" && VARY_STRENGTHS.includes(v as VaryStrength);
}

/**
 * Display label for a persisted strength — used by the IterationRow
 * caption ("vary · subtle") and the InputBar picker. Tolerant of
 * arbitrary numbers (hand-edited rows) by falling back to the raw
 * value so history always renders something truthful.
 */
export function varyStrengthLabel(v: number | null | undefined): string {
  if (v === 0.45) return "subtle";
  if (v === 0.6) return "medium";
  if (v === 0.75) return "wild";
  return typeof v === "number" ? v.toFixed(2) : "";
}
