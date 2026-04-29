/**
 * The shared image prompt builder for the "make this beautiful" tool.
 *
 * Used by `scripts/smoke.ts` and `lib/gemini/runIteration.ts`. The prompt is
 * derived from the per-iteration `presets` array (a subset of `PRESETS` from
 * `lib/db/schema.ts`). Same prompt is sent on every parallel call within an
 * iteration; temperature stays at default (1.0) so N parallel calls produce
 * N different results.
 *
 * Per-preset architecture (see also `docs/PROMPT_LESSONS.md` for cross-cutting
 * lessons):
 *
 *   **Dominators** — preset has a dedicated multi-paragraph body validated in
 *   Krea. When the preset is checked, its body short-circuits the builder and
 *   any other checked presets are subsumed. This is intentional: dominator
 *   prompts include strong preserve-this-aspect language that contradicts
 *   "vary X" composers (e.g. Background v3 says "palette family stays
 *   identical", which would clash with Color's "vary the palette"). If the
 *   user wants compound edits — e.g. fresh background AND new colors — they
 *   run two passes: Background first, then Color on a favorited result.
 *     - Ambiance v8 (locked) — see `AMBIANCE_PROMPT_BODY`.
 *     - Background v3 (locked) — see `BACKGROUND_PROMPT_BODY`.
 *
 *   **Composers** — preset participates in the templated "Reimagine X,
 *   preserve Y" path. Multiple composers can stack (Color + Lighting renders
 *   "Reimagine the colors and palette and the lighting and mood, ..."). The
 *   solo Color rendering is also frozen as `COLOR_PROMPT_BODY` for byte-
 *   identical lock-in (a future change to PRESERVE_LIST or
 *   PRESET_REMOVES_FROM_PRESERVE could otherwise shift Color's solo output
 *   silently).
 *     - Color (solo: locked body; combined: templated).
 *     - Lighting (templated, both solo and combined). Not yet locked — when
 *       Jeff iterates Lighting in Krea, it'll get the same dedicated-body
 *       treatment.
 *
 *   **Empty presets** — the validated freeform v0 "make this beautiful"
 *   prompt. Vary colors, preserve everything else. Bit-identical to what
 *   Zuzi approved in the original smoke runs.
 *
 * Resolution order in `buildPrompt`:
 *   1. presets is empty → freeform.
 *   2. presets includes 'ambiance' → AMBIANCE_PROMPT_BODY.
 *   3. presets includes 'background' → BACKGROUND_PROMPT_BODY.
 *   4. presets is exactly ['color'] → COLOR_PROMPT_BODY.
 *   5. otherwise → templated path (Lighting solo, Color+Lighting).
 *
 * Preset order in templated rendering is FIXED (color → ambiance → lighting
 * → background) regardless of the order the array is delivered in. This
 * makes the prompt deterministic for a given preset set and keeps the
 * prompt cache stable across UI permutations.
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

// ---------------------------------------------------------------------------
// COLOR — frozen body for solo rendering.
// ---------------------------------------------------------------------------

/**
 * Color prompt body — **frozen**. This is byte-identical to what the
 * templated path produces for `presets: ['color']` as of the freeze date,
 * captured here so a future change to `PRESERVE_LIST` /
 * `PRESET_REMOVES_FROM_PRESERVE` can't silently shift Color's solo output.
 * If the templated text needs to change, update this constant in lockstep
 * (or run `--presets color` smoke to verify the rendered output still
 * matches what's been validated in Krea).
 *
 * Color is a composer (not a dominator) — the templated path still handles
 * Color combined with Lighting. This constant is consulted only when
 * `presets` is exactly `['color']`.
 *
 * Single-line body; the aspect-ratio sentence is appended with a single
 * space at render time, matching the templater's behavior.
 */
const COLOR_PROMPT_BODY =
  "This painting is shown as the input image. Reimagine the colors and palette, picking whatever choices you think will make this painting as beautiful as possible. Preserve the brushwork, mark-making, and drawing style, the composition and framing, the subject and what is depicted, the level of finish, the value structure, the lighting and mood, and the background and setting exactly.";

// ---------------------------------------------------------------------------
// AMBIANCE — v8 locked.
// ---------------------------------------------------------------------------

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
 * evidence > prose elegance. See `docs/PROMPT_LESSONS.md` for the full
 * cross-prompt rule set.
 *
 * Multi-paragraph body; the aspect-ratio sentence is appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const AMBIANCE_PROMPT_BODY = `Continue this painting in the same style the artist is already using. Look at her brushwork, her marks, her flatness or dimensionality, her color application, her level of finish — and add more of the same. Extend her painting in her own voice. But do so in a way that completes the painting in the most satisfying way visually.

Do NOT make the image busy or change the composition. Your final image should look like the input image with additional work put into completing the image in a way that she would likely have completed it. It should feel not overly empty or not overfilled with new things.

You can add elements — a small object, a mark in negative space, something in the background, atmospheric depth — but everything you add must be painted in HER style, with HER kind of marks. If she's working flat and painterly, your additions are flat and painterly. If she's using thick gestural strokes, your additions are thick gestural strokes. Match her hand exactly.

The output should look like a finished version of the input painting.`;

// ---------------------------------------------------------------------------
// BACKGROUND — v3 locked.
// ---------------------------------------------------------------------------

/**
 * Background prompt body — **v3 (LOCKED)**. Validated by Jeff in Krea against
 * multiple Zuzi WIPs.
 *
 * Operation: replace the existing background with a different setting,
 * painted in her hand. NOT "make a beautiful background" (which Pro defaults
 * to rendering as a generic AI-illustration) — instead, "her hand made this,
 * in this same session, with the same brushes." The anti-language ("Do NOT
 * use AI-illustration finish") is required: Pro's default is exactly the
 * thing we're forbidding.
 *
 * **Iteration lineage:**
 *   - v1 (templated, original): "as beautiful as possible" framing — drifted
 *     to rendered AI-style backgrounds, generic illustration finish.
 *   - v2 (Krea iteration): added style anchoring + her-hand language +
 *     "she would have chosen" judgment imitation.
 *   - **v3 (locked)**: refined v2 with concrete examples (interior figure →
 *     a different interior; still life → a different surface or setting).
 *     Validated in Krea against multiple WIPs.
 *   - v4 (rejected): added abstract-background option; biased Pro toward
 *     abstract by giving it as a choice.
 *   - v5 (rejected): tried three options on a spectrum; still produced
 *     unbalanced output.
 *
 * **Lesson:** Pro handles narrow operations better than broad ones. When a
 * preset has multiple legitimate interpretations, pick the one that lands
 * more reliably and don't try to support both as choices in the prompt. See
 * `docs/PROMPT_LESSONS.md`.
 *
 * Multi-paragraph body; the aspect-ratio sentence is appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const BACKGROUND_PROMPT_BODY = `This painting needs a different background environment. Replace the existing background with a new one — different setting, different surroundings — but paint it in the same style the artist is already using. Look at her brushwork, her marks, her flatness or dimensionality, her color application, her level of finish — and paint the new background using exactly those same qualities. The new background must look like SHE painted it, in this same session, with the same brushes.

Do NOT introduce a rendered, smooth, photographic, or generically "beautiful" background. Do NOT use AI-illustration finish. The background should feel like her hand made it — gestural where she's gestural, flat where she's flat, sketchy where she's sketchy, painterly where she's painterly. Match her color palette family. Match her level of finish exactly.

Pick a background environment she would have chosen — something that fits the mood and subject of her painting. If she's painted an interior figure, the new background might be a different interior. If she's painted a still life, a different surface or setting. Make a choice that feels in character with the rest of the work.

The figure, subject, composition, framing, palette family, lighting direction, and brushwork on the foreground all stay IDENTICAL to the input. Only the background environment changes — and it changes into something painted in her hand, not Pro's hand.

The output should look like the input painting, repainted by the same artist with the same brushes in the same session, with a different choice of background. Same hand, same voice, different setting.`;

// ---------------------------------------------------------------------------
// Templated path — for Lighting solo and Color+Lighting combos.
// ---------------------------------------------------------------------------

/** What each preset commands the model to vary, when checked. Ambiance and
 *  Background have placeholders here for type-completeness but are never
 *  rendered through the templated path — their early-returns in
 *  `buildPrompt` catch them first. */
const PRESET_LABEL: Record<Preset, string> = {
  color: "the colors and palette",
  ambiance: "the atmospheric depth and ambient presence (handled separately)",
  lighting: "the lighting and mood",
  background: "the background environment and setting (handled separately)",
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
 * because changing lighting necessarily changes values). Ambiance and
 * Background entries are unused — both bypass the templated path. */
const PRESET_REMOVES_FROM_PRESERVE: Record<Preset, ReadonlyArray<string>> = {
  color: ["color"],
  ambiance: [], // unreachable — ambiance has its own prompt body
  lighting: ["lighting", "value"],
  background: [], // unreachable — background has its own prompt body
};

export interface BuildPromptArgs {
  presets: ReadonlyArray<Preset>;
  aspectRatio: string;
}

export function buildPrompt({ presets, aspectRatio }: BuildPromptArgs): string {
  // 1. Empty → the validated v0 prompt (verbatim — Zuzi approved this during
  //    smoke runs; do not paraphrase).
  if (presets.length === 0) {
    return `This painting is shown as the input image. Reimagine it with new colors of your own choosing — pick whatever colors you think will make this painting as beautiful as possible. Preserve the brushwork, drawing style, marks, composition, subject, level of finish, and value structure exactly. Only the colors change. Match the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 2. Ambiance dominates — when checked, the dedicated v8 style-continuation
  //    prompt fires. Other checked presets are intentionally subsumed because
  //    mixing ambiance's "continue in her style" directive with e.g. color's
  //    "vary the palette" produces contradictory instructions.
  if (presets.includes("ambiance")) {
    return `${AMBIANCE_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 3. Background dominates — same reason. v3 says "palette family stays
  //    identical" which would clash with Color, and "lighting direction stays
  //    identical" which would clash with Lighting. If Zuzi wants compound
  //    edits she runs two passes (Background, then Color on a favorite).
  if (presets.includes("background")) {
    return `${BACKGROUND_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 4. Color solo → frozen body. Color combined with Lighting falls through
  //    to the templated path below.
  if (presets.length === 1 && presets[0] === "color") {
    return `${COLOR_PROMPT_BODY} Match the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 5. Templated path — composers (Color and/or Lighting) without ambiance
  //    or background. Renders "Reimagine X, preserve Y" with Y filtered by
  //    each checked preset's removals from the preserve list.
  //
  //    Project to a deduped, stably-ordered array of valid presets. The
  //    filter ensures that a malformed input (already validated upstream,
  //    but still) can't punch through to the prompt.
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
