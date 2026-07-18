/**
 * Build-time prompt-builder check.
 *
 * Runs as part of `npm run build` so a deploy fails if `buildPrompt` ever
 * throws, returns an empty string, or silently regresses one of the locked
 * prompt bodies. Catches the class of bug that wouldn't fail tsc but would
 * ship a broken or wrong prompt to Pro.
 *
 * What it verifies:
 *   1. All 64 preset combinations × 4 representative aspect ratios produce
 *      a non-empty string with the aspect ratio sentence interpolated.
 *      (Combinations = 2^N where N = |PRESETS|; 6 presets → 64 subsets.)
 *   2. `buildPrompt` never throws.
 *   3. Canary substring checks against each locked body, so a typo /
 *      paraphrase / accidental refactor that loses the validated text
 *      surfaces here instead of in production:
 *        - v0 freeform: "Reimagine it with new colors"
 *        - Ambiance v8: opening "Continue this painting in the same style…"
 *          + the load-bearing "HER style" anchor
 *        - Background v5: opening "This painting needs its background
 *          developed and improved" + read-source anchor "Read the source
 *          carefully first" + indoor/outdoor invariant "Indoor stays
 *          indoor. Outdoor stays outdoor." + motif-preservation anchor
 *          "preserve those motifs as part of the composition" + canonical
 *          mood anchor "PEACEFUL, GENTLE, and QUIETLY WARM" (shared with
 *          Color v4)
 *        - Color v4: push-not-refine opener "This painting's colors
 *          should be developed and pushed…" + active-posture anchor
 *          "with confidence and joy" + active-push anchor "Make the
 *          colors sing" + anti-timid anchor "make confident pushed
 *          choices" + canonical mood anchor "PEACEFUL, GENTLE, and
 *          QUIETLY WARM" (same byte string as Background v5) +
 *          skin-identity anchor "Skin is identity — never touch it"
 *        - Lighting v1: opener "This painting's lighting should be
 *          developed and pushed"
 *        - Avery v1: lowercase opener "do this like a milton avery"
 *          (the body is intentionally lowercase + brief; the canary
 *          locks the prefix so any future re-cap of the body fails
 *          the build)
 *        - Etching v1: lowercase opener "add classical old master
 *          shadow hatching" (same lock-the-opening pattern as Avery;
 *          the locked body is constraint-heavy and the opener is the
 *          most stable identifier for drift detection)
 *   4. Dominator routing — Ambiance, Background, and Color (a dominator
 *      since v2; current lock is v4) early-returns still fire when combined
 *      with other presets. The failure mode is someone reorders the
 *      resolution ladder and breaks dominance silently.
 *
 * Background: the Ambiance v8 deploy at 088b3f9 failed on Railway for
 * environmental reasons (cache / native rebuild / Railpack quirk — the
 * source at 088b3f9 was clean-buildable locally). Production silently kept
 * serving v1-style Ambiance until the next successful deploy carried v8
 * along. A green Railway build is no longer enough — we want green build
 * AND a verified prompt rendering in the same step.
 *
 * If this script ever fails, DO NOT bypass it. Fix the prompt builder.
 */

import {
  buildPrompt,
  buildStyleBlendPrompt,
  buildStyleExplorePrompt,
  STYLE_BLEND_DIRECTIVE,
  STYLE_EXPLORE_DIRECTIVE,
  STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE,
} from "../lib/gemini/imagePrompts";
import {
  VARY_PROMPT,
  VARY_STRENGTHS,
  varyStrengthLabel,
} from "../lib/fal/varyConstants";
import {
  FAL_STYLE_EXPLORE_DIRECTIVE,
  FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE,
  FAL_STYLE_EXPLORE_LOOSE_DIRECTIVE,
  FAL_STYLE_EXPLORE_LOOSE_KEEP_COLORS_DIRECTIVE,
} from "../lib/fal/engineConstants";
import { PRESETS, type Preset } from "../lib/db/schema";

const RATIOS = ["1:1", "4:5", "16:9", "9:16"] as const;

interface Failure {
  combo: string;
  reason: string;
}

const failures: Failure[] = [];
const fail = (combo: string, reason: string) => failures.push({ combo, reason });

/** All 2^N subsets of PRESETS, in mask order (consistent across runs). */
function allCombos(): Preset[][] {
  const out: Preset[][] = [];
  for (let mask = 0; mask < 1 << PRESETS.length; mask++) {
    const c: Preset[] = [];
    for (let i = 0; i < PRESETS.length; i++) {
      if (mask & (1 << i)) c.push(PRESETS[i]);
    }
    out.push(c);
  }
  return out;
}

const combos = allCombos();
let totalRenders = 0;

// --- 1, 2: exhaustive non-empty / no-throw / aspect-ratio interpolation ---
for (const presets of combos) {
  for (const aspectRatio of RATIOS) {
    const label = `presets=[${presets.join(",")}] aspectRatio=${aspectRatio}`;
    let prompt = "";
    try {
      prompt = buildPrompt({ presets, aspectRatio });
    } catch (e) {
      fail(label, `buildPrompt threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    totalRenders++;
    if (typeof prompt !== "string") {
      fail(label, `did not return a string (got ${typeof prompt})`);
      continue;
    }
    if (prompt.length < 100) {
      fail(label, `suspiciously short prompt (${prompt.length} chars): ${JSON.stringify(prompt)}`);
    }
    if (!prompt.includes(`Match the input aspect ratio exactly (${aspectRatio})`)) {
      fail(
        label,
        `aspect-ratio sentence missing or interpolation broken (expected literal "${aspectRatio}" inside the canonical sentence)`,
      );
    }
  }
}

// --- 3: canary regression checks per locked body ---
const empty = buildPrompt({ presets: [], aspectRatio: "4:5" });
if (!empty.includes("Reimagine it with new colors")) {
  fail("[]", "v0 freeform prompt regressed (canary 'Reimagine it with new colors' missing)");
}

const ambiance = buildPrompt({ presets: ["ambiance"], aspectRatio: "4:5" });
if (!ambiance.startsWith("This painting is the artist's work-in-progress.")) {
  fail("[ambiance]", "Ambiance prompt regressed (opening sentence canary missing)");
}
if (!ambiance.includes("HER style")) {
  fail("[ambiance]", "Ambiance v8 lost load-bearing 'HER style' anchor");
}

const background = buildPrompt({ presets: ["background"], aspectRatio: "4:5" });
if (!background.startsWith("This painting needs its background developed and improved")) {
  fail("[background]", "Background v5 prompt regressed (read-and-develop opener canary missing)");
}
if (!background.includes("Read the source carefully first")) {
  fail("[background]", "Background v5 lost read-source anchor ('Read the source carefully first') — risk of swap-instead-of-develop regression (lesson #8)");
}
if (!background.includes("Indoor stays indoor. Outdoor stays outdoor.")) {
  fail("[background]", "Background v5 lost indoor/outdoor invariant anchor — Pro may swap setting type (lesson #8)");
}
if (!background.includes("preserve those motifs as part of the composition")) {
  fail("[background]", "Background v5 lost motif-preservation anchor — Pro may strip her decorative motifs (polka dots, pattern, etc.)");
}
if (!background.includes("PEACEFUL, GENTLE, and QUIETLY WARM")) {
  fail("[background]", "Background v5 lost canonical mood-register anchor ('PEACEFUL, GENTLE, and QUIETLY WARM') shared with Color v4 — risk of mood drift (lesson #7)");
}

const colorSolo = buildPrompt({ presets: ["color"], aspectRatio: "4:5" });
if (!colorSolo.startsWith("This painting's colors should be developed and pushed")) {
  fail("[color]", "Color v4 prompt regressed (push-not-refine opener canary missing)");
}
if (!colorSolo.includes("with confidence and joy")) {
  fail("[color]", "Color v4 lost active-painterly-posture anchor ('with confidence and joy') — risk of regressing to v3 timid lateral shifts (lesson #9)");
}
if (!colorSolo.includes("Make the colors sing")) {
  fail("[color]", "Color v4 lost active-push anchor ('Make the colors sing') — risk of regressing to v3 lifeless refinement (lesson #9)");
}
if (!colorSolo.includes("make confident pushed choices")) {
  fail("[color]", "Color v4 lost anti-timid anchor ('make confident pushed choices') — Pro will revert to timid lateral shifts without the explicit forbid (lesson #9)");
}
if (!colorSolo.includes("PEACEFUL, GENTLE, and QUIETLY WARM")) {
  fail("[color]", "Color v4 lost canonical mood-register anchor ('PEACEFUL, GENTLE, and QUIETLY WARM') shared with Background v5 — risk of cartoon-mood-override regression (lesson #7)");
}
if (!colorSolo.includes("Skin is identity — never touch it")) {
  fail("[color]", "Color v4 lost skin-identity anchor ('Skin is identity — never touch it') — risk of skin-tone-shift regression (lesson #7)");
}

const lightingSolo = buildPrompt({ presets: ["lighting"], aspectRatio: "4:5" });
if (!lightingSolo.startsWith("This painting's lighting should be developed and pushed")) {
  fail("[lighting]", "Lighting v1 prompt regressed (push-the-lighting opener canary missing)");
}

const averySolo = buildPrompt({ presets: ["avery"], aspectRatio: "4:5" });
if (!averySolo.startsWith("do this like a milton avery")) {
  fail("[avery]", "Avery v1 prompt regressed (lowercase 'do this like a milton avery' opener canary missing)");
}

// Cezanne v1 (v5.8) — second painter-reference preset + the always-on
// default. Same brief-body architecture as Avery; lock the lowercase
// study-then-paint opener + the preserve clause.
const cezanneSolo = buildPrompt({ presets: ["cezanne"], aspectRatio: "4:5" });
if (!cezanneSolo.startsWith("study paul cezanne's paintings")) {
  fail("[cezanne]", "Cezanne v1 prompt regressed (lowercase 'study paul cezanne's paintings' opener canary missing)");
}
if (!cezanneSolo.includes("while preserving the character and subjects")) {
  fail("[cezanne]", "Cezanne v1 prompt lost the preserve-character clause");
}

const etchingSolo = buildPrompt({ presets: ["etching"], aspectRatio: "4:5" });
if (!etchingSolo.startsWith("add classical old master shadow hatching")) {
  fail("[etching]", "Etching v1 prompt regressed (lowercase 'add classical old master shadow hatching' opener canary missing)");
}

// Style Explore v1 — the directive is byte-locked from Jeff's Krea
// validation. The plan note marked this canary as N/A ("directive is
// constant"), but a constant can still be paraphrased by anyone editing
// the file; the canary catches that at build time before the prompt drift
// reaches production. Same defensive pattern as Avery/Etching openers.
const styleExplore = buildStyleExplorePrompt("4:5");
if (!styleExplore.startsWith("keep the character design exactly as is from image one")) {
  fail("[style_explore]", "STYLE_EXPLORE_DIRECTIVE regressed (lowercase 'keep the character design exactly as is from image one' opener canary missing)");
}
if (!styleExplore.includes(STYLE_EXPLORE_DIRECTIVE)) {
  fail("[style_explore]", "buildStyleExplorePrompt no longer emits the canonical STYLE_EXPLORE_DIRECTIVE constant");
}
if (!styleExplore.includes("Match the input aspect ratio exactly (4:5)")) {
  fail("[style_explore]", "buildStyleExplorePrompt dropped the aspect-ratio sentence");
}

// v5.6 "Her colors" variant — the keep-source-colors directive. Locks:
//   1. the opener (palette-from-image-one framing)
//   2. the anti-color-import clause ("do not take colors from image 2")
//   3. buildStyleExplorePrompt(aspect, true) emits the variant + the
//      aspect sentence, while (aspect, false) stays byte-identical to
//      the original locked directive path above.
const styleExploreKeep = buildStyleExplorePrompt("4:5", true);
if (
  !styleExploreKeep.startsWith(
    "keep the character design and the exact color palette from image one",
  )
) {
  fail(
    "[style_explore_keep_colors]",
    "STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE regressed (opener canary missing)",
  );
}
if (!styleExploreKeep.includes("do not take colors from image 2")) {
  fail(
    "[style_explore_keep_colors]",
    "STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE lost the anti-color-import clause",
  );
}
if (!styleExploreKeep.includes(STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE)) {
  fail(
    "[style_explore_keep_colors]",
    "buildStyleExplorePrompt(aspect, true) no longer emits the keep-colors constant",
  );
}
if (!styleExploreKeep.includes("Match the input aspect ratio exactly (4:5)")) {
  fail(
    "[style_explore_keep_colors]",
    "keep-colors variant dropped the aspect-ratio sentence",
  );
}
if (buildStyleExplorePrompt("4:5", false) !== styleExplore) {
  fail(
    "[style_explore_keep_colors]",
    "buildStyleExplorePrompt(aspect, false) must stay byte-identical to the original path",
  );
}
// v5.7 "Loose" variants — subtractive locks. Four checks:
//   1. loose opener (no preservation clauses, image-one anchoring)
//   2. loose contains NO "keep the character" wording (subtraction is
//      the spec — additive drift fails the build)
//   3. loose×her-colors keeps the palette clause + drops character
//      clauses
//   4. fal loose retains the anti-borrow sentence (theft protection is
//      deliberate and load-bearing)
const styleExploreLoose = buildStyleExplorePrompt("4:5", false, true);
if (
  !styleExploreLoose.startsWith(
    "show a completed work from image one in the completed style of image 2",
  )
) {
  fail(
    "[style_explore_loose]",
    "STYLE_EXPLORE_LOOSE_DIRECTIVE regressed (opener canary missing)",
  );
}
// v5.8.1 loose v2: the liberties happen inside HER vocabulary — every
// loose variant must carry the line-and-shape anchor (the v1 loose
// wording let the reference's shape grammar walk in; Jeff: "it uses
// their shape style and it sucks").
for (const [label, text] of [
  ["style_explore_loose", styleExploreLoose],
  ["style_explore_loose_keep", buildStyleExplorePrompt("4:5", true, true)],
  ["fal_style_explore_loose", FAL_STYLE_EXPLORE_LOOSE_DIRECTIVE],
  ["fal_style_explore_loose_keep", FAL_STYLE_EXPLORE_LOOSE_KEEP_COLORS_DIRECTIVE],
] as const) {
  if (!/line and shape/.test(text)) {
    fail(
      `[${label}]`,
      "loose v2 variant lost the line-and-shape anchor (reference shape-grammar import guard)",
    );
  }
}
if (/keep the (exact )?character/i.test(styleExploreLoose)) {
  fail(
    "[style_explore_loose]",
    "loose variant re-grew a character-preservation clause — the spec is subtractive",
  );
}
const styleExploreLooseKeep = buildStyleExplorePrompt("4:5", true, true);
if (
  !styleExploreLooseKeep.includes("keep the exact color palette from image one") ||
  /keep the (exact )?character/i.test(styleExploreLooseKeep)
) {
  fail(
    "[style_explore_loose_keep]",
    "loose×her-colors variant must keep the palette clause and drop the character clauses",
  );
}
if (
  !FAL_STYLE_EXPLORE_LOOSE_DIRECTIVE.includes(
    "Do not reuse any subject or content from image 2",
  ) ||
  FAL_STYLE_EXPLORE_LOOSE_DIRECTIVE.includes("preserving image 1's exact")
) {
  fail(
    "[fal_style_explore_loose]",
    "fal loose variant must retain the anti-borrow sentence and drop the preserving clause",
  );
}
if (
  !FAL_STYLE_EXPLORE_LOOSE_KEEP_COLORS_DIRECTIVE.includes(
    "it is a texture reference only",
  ) ||
  FAL_STYLE_EXPLORE_LOOSE_KEEP_COLORS_DIRECTIVE.includes("preserving image 1's exact")
) {
  fail(
    "[fal_style_explore_loose_keep]",
    "fal loose×her-colors variant must retain texture-only + drop the preserving clause",
  );
}

// fal-engine keep-colors variant: opener + texture-only clause.
if (
  !FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE.startsWith(
    "Take the character, composition, and color palette from image 1",
  )
) {
  fail(
    "[fal_style_explore_keep_colors]",
    "FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE regressed (opener canary missing)",
  );
}
if (
  !FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE.includes(
    "it is a texture reference only",
  )
) {
  fail(
    "[fal_style_explore_keep_colors]",
    "FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE lost the texture-reference-only clause",
  );
}

// And via the unified buildPrompt entrypoint with mode='style_explore' —
// the presets array must be IGNORED (passing a contradictory preset
// should not change the output bytes).
const styleExploreViaBuild = buildPrompt({
  presets: ["color"],
  aspectRatio: "4:5",
  mode: "style_explore",
});
if (styleExploreViaBuild !== styleExplore) {
  fail(
    "[mode=style_explore]",
    "buildPrompt with mode='style_explore' must equal buildStyleExplorePrompt — presets must be ignored when mode is style_explore",
  );
}

// Style Blend v1 — verbatim user-supplied directive. Locked in code
// alongside STYLE_EXPLORE_DIRECTIVE; the canary catches the same
// paraphrase-by-edit failure mode (someone "improves" the wording
// without re-validating in production). Three checks:
//   1. The constant matches the byte-for-byte intent
//   2. The full prompt includes the aspect-ratio sentence
//   3. buildStyleBlendPrompt returns the constant + the sentence
const styleBlend = buildStyleBlendPrompt("4:5");
if (!styleBlend.startsWith("Make a new painting using the best aspects")) {
  fail(
    "[style_blend]",
    "STYLE_BLEND_DIRECTIVE regressed (opener 'Make a new painting using the best aspects' canary missing)",
  );
}
if (!styleBlend.includes(STYLE_BLEND_DIRECTIVE)) {
  fail(
    "[style_blend]",
    "buildStyleBlendPrompt no longer emits the canonical STYLE_BLEND_DIRECTIVE constant",
  );
}
if (!styleBlend.includes("Match the output aspect ratio exactly (4:5)")) {
  fail(
    "[style_blend]",
    "buildStyleBlendPrompt dropped the aspect-ratio sentence",
  );
}

// And via the unified buildPrompt entrypoint with mode='style_blend' —
// the presets array must be IGNORED (passing a contradictory preset
// should not change the output bytes). Parallel to the style_explore
// equivalence check above. Defense-in-depth: runIteration currently
// short-circuits BEFORE buildPrompt, but any future "unified entry
// point" refactor must still route mode='style_blend' to the locked
// directive — without this canary, a silent re-order of the ladder
// could fall through to the v0 freeform prompt for blend iterations
// and the build would still pass.
const styleBlendViaBuild = buildPrompt({
  presets: ["color"],
  aspectRatio: "4:5",
  mode: "style_blend",
});
if (styleBlendViaBuild !== styleBlend) {
  fail(
    "[mode=style_blend]",
    "buildPrompt with mode='style_blend' must equal buildStyleBlendPrompt — presets must be ignored when mode is style_blend",
  );
}

// --- 3f: v5 Sketch Vary locked prompt + strength set (AGENTS.md §16) ---
// The vary engine is fal FLUX + the ZUZQ LoRA, not Gemini — its locked
// directive lives in lib/fal/varyConstants.ts (dependency-free module;
// lib/fal/vary.ts re-exports it for the worker). Byte-locked from the
// July 2026 lab run that won the Gemini-vs-LoRA A/B. Anchors:
//   - opener "ZUZQ style rough sketch." — the trigger word IS the
//     style invocation; losing it silently degrades every vary call.
//   - "keep every element exactly where it is" + "Add nothing new." —
//     the product invariant (settle/perfect, no new iconography) that
//     22 rounds of Gemini prompting were fought over.
// The strength set + labels are locked too: the route validates the
// closed set, the UI renders the labels — a drive-by "tune" of either
// must be a deliberate two-file edit.
if (!VARY_PROMPT.startsWith("ZUZQ style rough sketch.")) {
  fail(
    "[sketch_vary]",
    "VARY_PROMPT regressed (opener 'ZUZQ style rough sketch.' canary missing — the trigger word is load-bearing)",
  );
}
if (!VARY_PROMPT.includes("keep every element exactly where it is")) {
  fail(
    "[sketch_vary]",
    "VARY_PROMPT lost the 'keep every element exactly where it is' anchor",
  );
}
if (!VARY_PROMPT.includes("Add nothing new.")) {
  fail(
    "[sketch_vary]",
    "VARY_PROMPT lost the 'Add nothing new.' anchor — the no-new-iconography invariant",
  );
}
if (JSON.stringify(VARY_STRENGTHS) !== "[0.45,0.6,0.75]") {
  fail(
    "[sketch_vary]",
    `VARY_STRENGTHS set changed (got ${JSON.stringify(VARY_STRENGTHS)}) — route validation, UI picker, and cost projection all key on the closed set`,
  );
}
if (
  varyStrengthLabel(0.45) !== "subtle" ||
  varyStrengthLabel(0.6) !== "medium" ||
  varyStrengthLabel(0.75) !== "wild"
) {
  fail(
    "[sketch_vary]",
    "varyStrengthLabel mapping regressed (expected subtle/medium/wild)",
  );
}

// --- 3g: v5.4 fal-engine style_explore directive (AGENTS.md §17) ---
// Max/Seedream run the BFL role-per-image + anti-bleed template that
// won them their picker slots in the July 2026 lab. Anchors: the
// role-decomposition opener + the anti-bleed clause (the #2 community
// failure mode — style-image subjects leaking into output).
if (
  !FAL_STYLE_EXPLORE_DIRECTIVE.startsWith(
    "Take the character and composition from image 1.",
  )
) {
  fail(
    "[fal style_explore]",
    "FAL_STYLE_EXPLORE_DIRECTIVE regressed (role-per-image opener canary missing)",
  );
}
if (
  !FAL_STYLE_EXPLORE_DIRECTIVE.includes(
    "it is a style reference only",
  )
) {
  fail(
    "[fal style_explore]",
    "FAL_STYLE_EXPLORE_DIRECTIVE lost the anti-bleed clause",
  );
}

// --- 4: dominator routing must fire when combined with other presets ---
const ambColor = buildPrompt({ presets: ["color", "ambiance"], aspectRatio: "4:5" });
if (!ambColor.startsWith("This painting is the artist's work-in-progress.")) {
  fail("[color,ambiance]", "Ambiance dominator early-return broken (combined with color)");
}

const bgLighting = buildPrompt({ presets: ["lighting", "background"], aspectRatio: "4:5" });
if (!bgLighting.startsWith("This painting needs its background developed and improved")) {
  fail("[lighting,background]", "Background dominator early-return broken (combined with lighting)");
}

// Color (a dominator since v2; current lock is v4) must win over Lighting.
// This is the case the templated path used to handle; under the locked body,
// Color's preserve list includes "lighting direction, and mood" so combining
// the two would produce contradictory directives. Color wins; user runs two
// passes for compound edits.
const colorLighting = buildPrompt({ presets: ["color", "lighting"], aspectRatio: "4:5" });
if (!colorLighting.startsWith("This painting's colors should be developed and pushed")) {
  fail("[color,lighting]", "Color dominator early-return broken (combined with lighting); previously templated, now must dominate");
}

const allFour = buildPrompt({
  presets: ["color", "ambiance", "lighting", "background"],
  aspectRatio: "4:5",
});
if (!allFour.startsWith("This painting is the artist's work-in-progress.")) {
  fail("[all four]", "Ambiance dominator must win over Background and Color when all are checked (resolution order regressed)");
}

// --- report ---
if (failures.length > 0) {
  console.error("[check-prompts] FAILED — prompt builder regression detected:");
  for (const f of failures) {
    console.error(`  - ${f.combo}: ${f.reason}`);
  }
  console.error(
    `\n${failures.length} failure(s). Fix the prompt builder; do NOT bypass this check.`,
  );
  process.exit(1);
}

console.log(
  `[check-prompts] ok — ${totalRenders} prompt renders across ${combos.length} preset combos × ${RATIOS.length} aspect ratios + 55 canary checks all green.`,
);
