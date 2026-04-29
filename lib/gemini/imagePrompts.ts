/**
 * The shared image prompt builder for the "make this beautiful" tool.
 *
 * Used by `scripts/smoke.ts` and `lib/gemini/runIteration.ts`. The prompt is
 * derived from the per-iteration `presets` array (a subset of `PRESETS` from
 * `lib/db/schema.ts`). Same prompt is sent on every parallel call within an
 * iteration; temperature stays at default (1.0) so N parallel calls produce
 * N different results.
 *
 * Semantics:
 *   - `presets: []` (empty) → the validated freeform "make this beautiful"
 *     prompt — vary colors, preserve everything else. This is the v0 prompt
 *     Zuzi approved during smoke runs; keeping it bit-identical avoids
 *     regressing the validated default.
 *   - `presets` includes `ambiance` → the dedicated atmospheric-pass prompt
 *     (see AMBIANCE_PROMPT_BODY). Ambiance is a focused additive operation
 *     ("add depth and feeling to empty areas"), not a "vary X" operation, so
 *     it doesn't compose with the standard vary-X / preserve-Y template.
 *     When ambiance is checked, its prompt takes priority and any other
 *     checked presets are subsumed — this is intentional, simpler than
 *     trying to merge contradictory directives ("match palette" + "vary
 *     palette"). Documented in AGENTS.md §4.
 *   - `presets: [<one or more, no ambiance>]` → builder constructs a "vary X,
 *     preserve Y" prompt. The vary list is the labels of the checked presets;
 *     the preserve list is the master preserve list MINUS items removed by
 *     each checked preset (e.g. `lighting` removes both "lighting" and "value
 *     structure" because lighting drives values).
 *
 * Preset order in the rendered prompt is FIXED (color → ambiance → lighting
 * → background) regardless of the order the array is delivered in. This makes
 * the prompt deterministic for a given preset set and keeps the prompt cache
 * stable across UI permutations.
 *
 * `aspectRatio` is always stated explicitly inside the prompt AND passed via
 * `config.imageConfig.aspectRatio` on the API call (belt-and-suspenders).
 * See AGENTS.md §3 ("Output aspect ratio always equals input aspect ratio")
 * and §4 ("Make this beautiful" tool).
 */

import { PRESETS, type Preset } from "../db/schema";

/** Default tiles per Submit. Single source of truth — DB column default
 * (`iterations.tile_count`) and API route default both reference this value. */
export const TILE_COUNT_DEFAULT = 3;

/** Hard ceiling on tiles per Submit. The API route refuses requests above
 * this value; the UI never offers a control beyond it. Chosen as the prior
 * 3×3 grid count so a reflexive "give me 9" still works without inflating
 * cost surface. */
export const TILE_COUNT_MAX = 9;

/** Stable order in which presets appear in the rendered prompt. */
const PRESET_ORDER: ReadonlyArray<Preset> = PRESETS;

/** Ambiance prompt body. Iterated from the user's spec after the first smoke
 *  showed Pro treating the original "Look at this painting and identify..."
 *  framing as a reimagining cue and drifting the palette + adding decorative
 *  patterns. This version leads with a hard editing directive, enumerates
 *  what must remain identical, and forbids decorative additions explicitly.
 *  The aspect-ratio sentence is appended at render time per AGENTS.md §3. */
const AMBIANCE_PROMPT_BODY =
  "Edit this painting by adding atmospheric depth and ambient presence ONLY to the empty, flat, or sparsely painted passages. This is a subtle additive overlay, NOT a reimagining. The figure, pose, clothing, facial features, hair, brushwork, marks, color palette, lighting, and composition must remain IDENTICAL to the input — anyone comparing the input and output side-by-side should see the developed passages as visually unchanged. In the bare areas (typically backgrounds, negative space, undeveloped canvas), add soft tonal modulation and gentle environmental suggestion: the kind of breathy painterly wash that suggests air and depth without depicting any specific object. Use ONLY hues already present in the input painting; do NOT introduce new colors. Do NOT add new subjects, new objects, new figures, decorative patterns, dots, or repeating motifs. Do NOT smooth, finish, or repaint passages the artist has already developed. The output should look like the input painting after the artist made one quiet atmospheric pass with a soft brush over the bare areas — same hand, same voice, same palette, more breath where the canvas was empty.";

/** What each preset commands the model to vary, when checked. Ambiance has a
 *  placeholder here for type-completeness but is never rendered through the
 *  vary-X path — the early-return in `buildPrompt` catches it first. */
const PRESET_LABEL: Record<Preset, string> = {
  color: "the colors and palette",
  ambiance: "the atmospheric depth and ambient presence (handled separately)",
  lighting: "the lighting and mood",
  background: "the background environment and setting",
};

/** Master preserve list, in stable rendering order. Each item has an `id` so
 * presets can selectively remove it when that aspect is being varied. */
const PRESERVE_LIST: ReadonlyArray<{ id: string; phrase: string }> = [
  { id: "color", phrase: "the original colors and palette" },
  { id: "brushwork", phrase: "the brushwork, mark-making, and drawing style" },
  { id: "composition", phrase: "the composition and framing" },
  { id: "subject", phrase: "the subject and what is depicted" },
  { id: "finish", phrase: "the level of finish" },
  { id: "value", phrase: "the value structure" },
  { id: "lighting", phrase: "the lighting and mood" },
  { id: "background", phrase: "the background and setting" },
];

/** Which preserve-list `id`s a given preset removes when checked. A preset
 * can remove more than its own name (e.g. lighting also removes "value"
 * because changing lighting necessarily changes values). Ambiance's entry
 * is unused — the early-return path bypasses this map. */
const PRESET_REMOVES_FROM_PRESERVE: Record<Preset, ReadonlyArray<string>> = {
  color: ["color"],
  ambiance: [], // unreachable — ambiance has its own prompt body
  lighting: ["lighting", "value"],
  background: ["background"],
};

export interface BuildPromptArgs {
  presets: ReadonlyArray<Preset>;
  aspectRatio: string;
}

export function buildPrompt({ presets, aspectRatio }: BuildPromptArgs): string {
  // Empty → the validated v0 prompt (verbatim — Zuzi approved this during
  // smoke runs; do not paraphrase).
  if (presets.length === 0) {
    return `This painting is shown as the input image. Reimagine it with new colors of your own choosing — pick whatever colors you think will make this painting as beautiful as possible. Preserve the brushwork, drawing style, marks, composition, subject, level of finish, and value structure exactly. Only the colors change. Match the input aspect ratio exactly (${aspectRatio}).`;
  }

  // Ambiance dominates — when checked, the dedicated atmospheric-pass prompt
  // is used. Other checked presets are intentionally subsumed because mixing
  // ambiance's "match the existing palette" directive with e.g. color's "vary
  // the palette" produces contradictory instructions. Simpler is right here:
  // ambiance is a focused additive operation, not a "vary X" knob.
  if (presets.includes("ambiance")) {
    return `${AMBIANCE_PROMPT_BODY} Match the input aspect ratio exactly (${aspectRatio}).`;
  }

  // Project to a deduped, stably-ordered array of valid presets. Filter
  // ensures that a malformed input (already validated upstream, but still)
  // can't punch through to the prompt.
  const checked = PRESET_ORDER.filter((p) => presets.includes(p));

  const varyPhrases = checked.map((p) => PRESET_LABEL[p]);
  const varyList = joinPhrases(varyPhrases);

  const removed = new Set<string>();
  for (const p of checked) {
    for (const id of PRESET_REMOVES_FROM_PRESERVE[p]) removed.add(id);
  }
  const preservePhrases = PRESERVE_LIST.filter((item) => !removed.has(item.id)).map(
    (item) => item.phrase,
  );
  const preserveSentence =
    preservePhrases.length > 0 ? ` Preserve ${joinPhrases(preservePhrases)} exactly.` : "";

  return `This painting is shown as the input image. Reimagine ${varyList}, picking whatever choices you think will make this painting as beautiful as possible.${preserveSentence} Match the input aspect ratio exactly (${aspectRatio}).`;
}

/** Oxford-comma list joiner: ["a"] → "a"; ["a","b"] → "a and b";
 * ["a","b","c"] → "a, b, and c". */
function joinPhrases(phrases: ReadonlyArray<string>): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}
