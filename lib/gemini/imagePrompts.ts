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
 *   **Dominators** — preset has a dedicated multi-paragraph body. When the
 *   preset is checked, its body short-circuits the builder and any other
 *   checked presets are subsumed. This is intentional: dominator prompts
 *   include strong preserve-this-aspect language that contradicts a "vary X"
 *   composer (e.g. Color v1 says "lighting direction stays identical", which
 *   would clash with Lighting). If the user wants compound edits — e.g.
 *   cel-animation colors AND new lighting — they run two passes: Color
 *   first, then Lighting on a favorited result.
 *     - Color v1 (locked) — see `COLOR_PROMPT_BODY`.
 *     - Ambiance v8 (locked) — see `AMBIANCE_PROMPT_BODY`.
 *     - Background v3 (locked) — see `BACKGROUND_PROMPT_BODY`.
 *
 *   **Composers** — would participate in the templated "Reimagine X,
 *   preserve Y" path. Today only Lighting falls here, and only when checked
 *   alone. When Jeff iterates Lighting in Krea it'll get the same locked-
 *   body + dominator treatment, at which point the templated path will
 *   have no callers and the builder collapses to a 4-way switch.
 *     - Lighting (templated, solo only — combinations with any of the
 *       three dominators get subsumed).
 *
 *   **Empty presets** — the validated freeform v0 "make this beautiful"
 *   prompt. Vary colors, preserve everything else. Bit-identical to what
 *   Zuzi approved in the original smoke runs.
 *
 * Resolution order in `buildPrompt`:
 *   1. presets is empty → freeform.
 *   2. presets includes 'ambiance' → AMBIANCE_PROMPT_BODY.
 *   3. presets includes 'background' → BACKGROUND_PROMPT_BODY.
 *   4. presets includes 'color' → COLOR_PROMPT_BODY.
 *   5. otherwise → templated path (only `['lighting']` reaches here).
 *
 * If multiple dominators are checked, the first hit in the ladder wins.
 * Order is deliberate: Ambiance is the broadest (voice continuation),
 * Background is setting-replacement, Color is palette-replacement.
 * Lighting is currently the only composer — it composes with itself, which
 * is to say it just renders solo via the templated path.
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
 * Color prompt body — **v1 (LOCKED)**. First opinionated Color version,
 * supplied by Jeff verbatim. Earlier "frozen byte-identical to the
 * templated output" snapshot is gone; this version targets a specific
 * aesthetic (1980s/90s hand-painted cel-animation palette sensibility)
 * rather than the generic "vary colors, preserve everything else"
 * framing the freeze inherited from the original templater.
 *
 * Honors the cross-prompt rules pinned in `docs/PROMPT_LESSONS.md`:
 *   - Anti-language: "Do NOT use AI-illustration finish", "Do NOT make
 *     the colors look digital or printed".
 *   - Narrow operation: pick ONE era / sensibility (cel animation 80s/90s)
 *     instead of offering Pro a buffet of color directions.
 *   - Judgment imitation: "feels drawn from that era" / "should feel
 *     hand-painted, like gouache backgrounds" — sensibility imitation
 *     beats outcome prescription.
 *   - Redundant style anchoring: "in HER existing brushwork and style.
 *     Her marks, her gestural quality, her flatness or dimensionality,
 *     her level of finish all stay identical." Multiple ways of saying
 *     the same preserve directive — load-bearing per the lessons doc.
 *
 * **Architectural change vs the prior frozen body**: the new prompt's
 * preserve list explicitly includes "lighting direction, and mood" —
 * which contradicts a Lighting checkbox checked alongside Color. So
 * Color promotes from composer (templated when combined) to **dominator**
 * (early-return regardless of other checked presets). Same routing
 * pattern as Ambiance v8 and Background v3. If Zuzi wants compound edits
 * (cel-animation colors AND new lighting), she runs two passes: Color
 * first, then Lighting on a favorited result.
 *
 * **Iteration lineage:**
 *   - v0 (frozen): byte-identical snapshot of the original templater's
 *     output for `['color']`. Generic "make the colors beautiful" with no
 *     aesthetic direction. Worked, but Pro picked whatever palette it
 *     felt like — nondeterministic across runs.
 *   - **v1 (locked)**: opinionated era-specific palette sensibility.
 *     Awaits Krea-on-Zuzi-WIPs validation; current canonical text is
 *     Jeff's spec verbatim.
 *
 * Multi-paragraph body; aspect-ratio sentence appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const COLOR_PROMPT_BODY = `This painting is shown as the input image. Recolor it using the palette sensibility of 1980s and 1990s Saturday morning cartoons and animated features — hand-painted cel animation from that era. Think Disney's late-80s/90s renaissance (Little Mermaid, Beauty and the Beast, Aladdin, Lion King), Don Bluth films (Land Before Time, All Dogs Go to Heaven), Saturday morning cartoons (DuckTales, Gargoyles, Batman: The Animated Series), and Studio Ghibli's 80s/90s output. Saturated but harmonious, painted backgrounds with rich color depth, bold complementary accents, slightly heightened "cartoon" color logic where the palette serves mood and storytelling.

Apply this color sensibility to the existing painting. Replace the current palette with one that feels drawn from that era — but paint it in HER existing brushwork and style. Her marks, her gestural quality, her flatness or dimensionality, her level of finish all stay identical. Only the color values change.

Preserve EXACTLY: the brushwork, mark-making, drawing style, composition, framing, subject, level of finish, value structure, lighting direction, and mood. Only the colors shift to the 80s/90s cel-animation palette sensibility.

Do NOT use AI-illustration finish or smooth her marks. Do NOT change the subject's appearance, proportions, or rendering style toward cartoon characters — only the color choices come from that era. Do NOT make the colors look digital or printed; the palette should feel hand-painted, like gouache backgrounds from that era of animation.`;

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
 * Background prompt body — **v4 (LOCKED)**. Validated by Jeff in Krea against
 * multiple Zuzi WIPs.
 *
 * Operation: replace the existing background with a different setting **in her
 * universe** (same kind of place — interior stays interior, outdoor stays
 * outdoor), with greater atmospheric depth (channeling 1980s/90s painted-
 * animation backgrounds for FEELING only, not finish), rendered entirely in
 * her style — including the SHAPE LANGUAGE of background elements. Pro's
 * default for "paint in her style" is to construct geometry with realistic
 * perspective and apply painterly surface as a texture overlay; v4 forbids
 * that explicitly and forces the geometry itself to be hers from
 * construction. See `docs/PROMPT_LESSONS.md` lesson #6.
 *
 * **Iteration lineage:**
 *   - v1 (templated, original): "as beautiful as possible" framing — drifted
 *     to rendered AI-style backgrounds, generic illustration finish.
 *   - v2 (Krea iteration): added style anchoring + her-hand language +
 *     "she would have chosen" judgment imitation.
 *   - v3 (previously locked): refined v2 with concrete examples (interior
 *     figure → a different interior; still life → a different surface or
 *     setting). Validated in Krea. Production-served until v4.
 *   - **v4 (locked)**: added 80s/90s animation atmospheric reference for
 *     mood depth + explicit shape-language anchoring (anti-perspective,
 *     anti-texture-overlay) — Jeff iterated extensively in Krea, Pro was
 *     constructing perfect-perspective geometry with painterly surface
 *     overlay; v4 forces the geometry itself to be in her hand from the
 *     construction stage. Replaces v3.
 *
 * **Lesson:** painterly surface alone isn't enough — when an operation
 * requires the artist's style to drive shape language (not just surface
 * treatment), the prompt must explicitly forbid the construct-then-texture
 * pattern and anchor the construction stage to her hand. See lesson #6 in
 * `docs/PROMPT_LESSONS.md`.
 *
 * Multi-paragraph body; the aspect-ratio sentence is appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const BACKGROUND_PROMPT_BODY = `This painting needs a different background environment within HER existing world. Stay in her universe — her subjects, her settings, her mood, the kinds of places her paintings depict. The new background should be the same KIND of setting her paintings already live in. If her painting shows a woman in a domestic interior, the new background is still a domestic interior. If her painting is set outdoors or in a quiet room, the new setting stays in that thematic world.

What changes is the visual richness and atmospheric depth of the background. Channel the painted-background quality of 1980s and 1990s hand-animated films — the way Belle's village interior feels warmly lit and atmospherically deep, the way Howl's bedroom feels rich with painted color and layered tone, the way the Lion King savanna feels saturated and dimensional. That feeling of mood and atmospheric color depth in the background, applied to her existing world.

But render everything entirely in HER style. Her exact brushwork, her exact marks, her exact level of finish, her exact line work, her exact surface treatment, her exact gestural quality. Do not borrow line work, finish quality, or rendering style from animation. Borrow only the FEELING of mood-rich painted backgrounds — the atmospheric depth, the considered warm/cool color play, the way the background carries emotional weight. Translate that feeling into her hand.

The SHAPES THEMSELVES of background elements must also come from her hand, not from realistic construction. She does not draw furniture, architecture, or objects using accurate perspective, correct proportions, or realistic geometry. Her shapes are simplified, gestural, slightly wonky, often flattened or distorted, with perspective that's broken, ignored, or treated loosely. A window in her work isn't a perspective-correct rectangle — it's a rough quadrilateral with wobbling lines. A table edge isn't a clean receding plane — it's a tilted shape drawn with the same exploratory line work as her figures. Architectural elements have approximate angles, not measured ones. Furniture has cartooned proportions, not realistic ones.

Do NOT construct background elements using accurate linear perspective and then apply painterly surface as a texture overlay. The shapes underneath must already be hers — wobbly, simplified, gestural — before any surface treatment is applied. If you find yourself drawing a "correct" window or "correct" piece of furniture, simplify it, distort it, flatten it, redraw it with her hand's wobble. The geometry is hers. The construction is hers. Not just the surface.

The foreground figure, subject, composition, framing, palette family, lighting direction, and brushwork all stay IDENTICAL to the input. Only the background environment changes — same kind of place, but with deeper atmospheric mood, painted in her hand, with shapes drawn the way her hand draws shapes.

The result should look like ONE coherent painting by ONE artist — her — where the background now has more atmospheric weight and painted richness, while staying in her painterly register and her world.

Do NOT change the type of setting (interior stays interior, outdoor stays outdoor). Do NOT use cel-animation finish or clean rendering. Do NOT bifurcate her foreground style from the background style. Do NOT introduce visual qualities (clean lines, smooth gradients, polished surfaces) that aren't already in her work. Do NOT use realistic perspective or accurate proportions for background elements.`;

// ---------------------------------------------------------------------------
// Templated path — for Lighting solo and Color+Lighting combos.
// ---------------------------------------------------------------------------

/** What each preset commands the model to vary, when checked. Ambiance and
 *  Background have placeholders here for type-completeness but are never
 *  rendered through the templated path — their early-returns in
 *  `buildPrompt` catch them first. */
const PRESET_LABEL: Record<Preset, string> = {
  color: "the colors and palette (handled separately)",
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
  color: [], // unreachable — color has its own prompt body (v1 dominator)
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

  // 4. Color dominates — v1 prompt's preserve list explicitly includes
  //    "lighting direction, and mood", which would contradict a Lighting
  //    checkbox checked alongside Color. Same dominator pattern as Ambiance
  //    and Background. If Zuzi wants Color + Lighting compound edits, she
  //    runs two passes (Color first, then Lighting on a favorite).
  if (presets.includes("color")) {
    return `${COLOR_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 5. Templated path — only reached for `['lighting']` solo today. Lighting
  //    hasn't been Krea-iterated yet; when it is, port to a dedicated body
  //    + early-return, same as the other three. The templated builder will
  //    then have no callers and can be deleted.
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
