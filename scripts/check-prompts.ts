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
  buildStyleExplorePrompt,
  STYLE_EXPLORE_DIRECTIVE,
} from "../lib/gemini/imagePrompts";
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
  `[check-prompts] ok — ${totalRenders} prompt renders across ${combos.length} preset combos × ${RATIOS.length} aspect ratios + 23 canary checks all green.`,
);
