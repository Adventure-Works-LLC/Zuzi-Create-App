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
 *   - `presets` includes `ambiance` → the dedicated v8 style-continuation
 *     prompt (see AMBIANCE_PROMPT_BODY). Ambiance is "complete the painting
 *     in her voice" — a focused style-continuation operation, not a "vary X"
 *     operation, so it doesn't compose with the standard vary-X / preserve-Y
 *     template. When ambiance is checked, its prompt takes priority and any
 *     other checked presets are subsumed — this is intentional, simpler than
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

/**
 * Ambiance prompt body — **v8 (LOCKED)**. Validated by Jeff in Krea against
 * multiple Zuzi WIPs; produces consistently good outputs and outperforms the
 * cleaner v7 variants in real-world use.
 *
 * DO NOT improve, shorten, or deduplicate the redundant style-anchoring
 * language. The redundancy is **load-bearing** — it's what makes Pro stay in
 * Zuzi's voice instead of drifting to a generic "atmospheric overlay" mode.
 * The two lines that say "in HER style, with HER kind of marks" and the
 * concrete "if she's working flat / if she's using thick gestural strokes"
 * examples look redundant on paper; they're the difference between Pro
 * imitating her hand vs. inventing a new one.
 *
 * **Iteration lineage** (kept so future tuning has the prior context, and to
 * document the failure modes):
 *   - v1: drifted, repainted everything.
 *   - v2: too subtle — atmospheric whisper barely visible against developed
 *     passages.
 *   - v3: bold but crowded — added too much.
 *   - v4: quantity-capped ("add no more than two elements"); still busy.
 *   - v5: position-locked ("only in the upper-left quadrant"); lost magic.
 *   - v6: aesthetic-outcome framing ("make it feel finished"); Pro rendered
 *     toward a 3D-illustration finish quality, away from her painterly hand.
 *   - v7: style-continuation framing; removed finish-quality vocabulary.
 *     Cleaner prose, but Pro still occasionally drifted to its default look.
 *   - **v8 (locked)**: style-continuation + concrete style examples
 *     ("flat and painterly" vs. "thick gestural strokes") + redundant
 *     style anchors ("HER style, with HER kind of marks") + "she would
 *     have completed it" judgment-imitation framing. Validated in Krea by
 *     Jeff across multiple Zuzi WIPs.
 *
 * **Lesson for future preset tuning:** longer prompts with redundant style-
 * anchoring may outperform cleaner shorter ones, especially when the goal
 * is voice-preservation. Don't deduplicate aggressively. Real-output
 * evidence > prose elegance.
 *
 * The aspect-ratio sentence is appended at render time per AGENTS.md §3.
 */
const AMBIANCE_PROMPT_BODY = `Continue this painting in the same style the artist is already using. Look at her brushwork, her marks, her flatness or dimensionality, her color application, her level of finish — and add more of the same. Extend her painting in her own voice. But do so in a way that completes the painting in the most satisfying way visually.

Do NOT make the image busy or change the composition. Your final image should look like the input image with additional work put into completing the image in a way that she would likely have completed it. It should feel not overly empty or not overfilled with new things.

You can add elements — a small object, a mark in negative space, something in the background, atmospheric depth — but everything you add must be painted in HER style, with HER kind of marks. If she's working flat and painterly, your additions are flat and painterly. If she's using thick gestural strokes, your additions are thick gestural strokes. Match her hand exactly.

The output should look like a finished version of the input painting.`;

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

  // Ambiance dominates — when checked, the dedicated v8 style-continuation
  // prompt is used. Other checked presets are intentionally subsumed because
  // mixing ambiance's "continue in her style" directive with e.g. color's
  // "vary the palette" produces contradictory instructions. Ambiance is a
  // focused style-continuation operation, not a "vary X" knob.
  //
  // The body is multiline (paragraph-separated) by design — v8 was validated
  // in Krea with this exact paragraph structure, so we preserve it. The
  // aspect-ratio sentence joins as its own trailing paragraph.
  if (presets.includes("ambiance")) {
    return `${AMBIANCE_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
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
