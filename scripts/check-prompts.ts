/**
 * Build-time prompt-builder check.
 *
 * Runs as part of `npm run build` so a deploy fails if `buildPrompt` ever
 * throws, returns an empty string, or silently regresses one of the locked
 * prompt bodies. Catches the class of bug that wouldn't fail tsc but would
 * ship a broken or wrong prompt to Pro.
 *
 * What it verifies:
 *   1. All 16 preset combinations × 4 representative aspect ratios produce
 *      a non-empty string with the aspect ratio sentence interpolated.
 *   2. `buildPrompt` never throws.
 *   3. Canary substring checks against each locked body, so a typo /
 *      paraphrase / accidental refactor that loses the validated text
 *      surfaces here instead of in production:
 *        - v0 freeform: "Reimagine it with new colors"
 *        - Ambiance v8: opening "Continue this painting in the same style…"
 *          + the load-bearing "HER style" anchor
 *        - Background v4: opening "This painting needs a different
 *          background environment within HER existing world." + the
 *          shape-language anchor "wobbly, simplified, gestural"
 *        - Color v3: refine-not-replace opener "Tune and refine the
 *          existing palette…" + mood-register anchor "PEACEFUL, GENTLE,
 *          and QUIETLY WARM" + skin-identity anchor "Skin is identity —
 *          never touch it"
 *   4. Dominator routing — Ambiance, Background, and Color (a dominator
 *      since v2; current lock is v3) early-returns still fire when combined
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

import { buildPrompt } from "../lib/gemini/imagePrompts";
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
if (!ambiance.startsWith("Continue this painting in the same style the artist is already using.")) {
  fail("[ambiance]", "Ambiance v8 prompt regressed (opening sentence canary missing)");
}
if (!ambiance.includes("HER style")) {
  fail("[ambiance]", "Ambiance v8 lost load-bearing 'HER style' anchor");
}

const background = buildPrompt({ presets: ["background"], aspectRatio: "4:5" });
if (!background.startsWith("This painting needs a different background environment within HER existing world.")) {
  fail("[background]", "Background v4 prompt regressed (opening sentence canary missing)");
}
if (!background.includes("wobbly, simplified, gestural")) {
  fail("[background]", "Background v4 lost shape-language anchor ('wobbly, simplified, gestural')");
}

const colorSolo = buildPrompt({ presets: ["color"], aspectRatio: "4:5" });
if (!colorSolo.startsWith("This painting is shown as the input image. Tune and refine the existing palette")) {
  fail("[color]", "Color v3 prompt regressed (refine-not-replace opener canary missing)");
}
if (!colorSolo.includes("PEACEFUL, GENTLE, and QUIETLY WARM")) {
  fail("[color]", "Color v3 lost mood-register anchor ('PEACEFUL, GENTLE, and QUIETLY WARM') — risk of cartoon-mood-override regression (lesson #7)");
}
if (!colorSolo.includes("Skin is identity — never touch it")) {
  fail("[color]", "Color v3 lost skin-identity anchor ('Skin is identity — never touch it') — risk of skin-tone-shift regression (lesson #7)");
}

// --- 4: dominator routing must fire when combined with other presets ---
const ambColor = buildPrompt({ presets: ["color", "ambiance"], aspectRatio: "4:5" });
if (!ambColor.startsWith("Continue this painting")) {
  fail("[color,ambiance]", "Ambiance dominator early-return broken (combined with color)");
}

const bgLighting = buildPrompt({ presets: ["lighting", "background"], aspectRatio: "4:5" });
if (!bgLighting.startsWith("This painting needs a different background")) {
  fail("[lighting,background]", "Background dominator early-return broken (combined with lighting)");
}

// Color (a dominator since v2; current lock is v3) must win over Lighting.
// This is the case the templated path used to handle; under the locked body,
// Color's preserve list includes "lighting direction, and mood" so combining
// the two would produce contradictory directives. Color wins; user runs two
// passes for compound edits.
const colorLighting = buildPrompt({ presets: ["color", "lighting"], aspectRatio: "4:5" });
if (!colorLighting.startsWith("This painting is shown as the input image. Tune and refine the existing palette")) {
  fail("[color,lighting]", "Color dominator early-return broken (combined with lighting); previously templated, now must dominate");
}

const allFour = buildPrompt({
  presets: ["color", "ambiance", "lighting", "background"],
  aspectRatio: "4:5",
});
if (!allFour.startsWith("Continue this painting")) {
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
  `[check-prompts] ok — ${totalRenders} prompt renders across ${combos.length} preset combos × ${RATIOS.length} aspect ratios + 10 canary checks all green.`,
);
