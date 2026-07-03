/**
 * Smoke run — Sketch Vary (v5) provider check.
 *
 * Exercises the PRODUCTION provider (`lib/fal/vary.ts generateVaryImage`)
 * directly: same locked VARY_PROMPT, same LoRA, same sampler settings,
 * same input resize — so the bytes this gate validates are the bytes
 * production serves. No DB, no R2, no UI — one fal call per strength,
 * local file writes only.
 *
 * Costs real money (~$0.035/image on fal). Default run = 3 images
 * (one per strength) ≈ $0.11.
 *
 * Flags:
 *   --sketch <path>        REQUIRED. One sketch image (jpg/png).
 *   --strength 0.45|0.6|0.75   run ONE strength instead of all three.
 *
 * Run:
 *   npm run smoke-vary -- --sketch samples/some-sketch.jpg
 *   node --env-file=.env --import tsx scripts/smoke-vary.ts --sketch <p>
 *
 * Env: FAL_KEY + ZUZQ_LORA_URL (both required; the provider throws a
 * clear message if either is missing).
 *
 * Outputs: samples/vary-smoke/<sketch-slug>__s<strength>.jpg
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  generateVaryImage,
  VARY_STRENGTHS,
  isVaryStrength,
  varyStrengthLabel,
  type VaryStrength,
} from "../lib/fal/vary";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return null;
}

async function main() {
  const sketchPath = argValue("sketch");
  if (!sketchPath) {
    console.error(
      "usage: npm run smoke-vary -- --sketch <path> [--strength 0.45|0.6|0.75]",
    );
    process.exit(1);
  }
  const strengthRaw = argValue("strength");
  let strengths: readonly VaryStrength[] = VARY_STRENGTHS;
  if (strengthRaw !== null) {
    const parsed = Number(strengthRaw);
    if (!isVaryStrength(parsed)) {
      console.error(
        `--strength must be one of ${VARY_STRENGTHS.join(", ")} (got ${strengthRaw})`,
      );
      process.exit(1);
    }
    strengths = [parsed];
  }

  const bytes = await readFile(sketchPath);
  const slug = basename(sketchPath)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(-32);
  const outDir = join("samples", "vary-smoke");
  await mkdir(outDir, { recursive: true });

  for (const strength of strengths) {
    const label = `smoke ${slug} s${strength}`;
    const t0 = Date.now();
    console.log(
      `[smoke-vary] ${varyStrengthLabel(strength)} (${strength}) — calling fal…`,
    );
    const out = await generateVaryImage(bytes, strength, label);
    const file = join(outDir, `${slug}__s${String(strength).replace(".", "")}.jpg`);
    await writeFile(file, out);
    console.log(
      `[smoke-vary] saved ${file} (${Math.round(out.length / 1024)}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
  console.log("[smoke-vary] done — eyeball the outputs before shipping.");
}

main().catch((e) => {
  console.error("[smoke-vary] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
