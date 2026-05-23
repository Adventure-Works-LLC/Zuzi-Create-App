/**
 * Smoke run — Style Explore mode pipeline check.
 *
 * THIS IS THE V2.0 GATE. No schema, no UI, no production code paths touched.
 * Just direct Gemini calls + local file writes. Jeff runs this against
 * sample sketches + style paintings, eyeballs the outputs (or shows them
 * to Zuzi). If quality matches what he got hand-rolled in Krea, we proceed
 * to v2.1 (schema + library). If not, debug the pipeline (input ordering?
 * sharp config? Gemini model version drift?) BEFORE designing any UI.
 *
 * Mirrors `scripts/smoke.ts` step-for-step where it makes sense, but skips
 * the DB and R2 — the gate's only job is to verify the multi-image Gemini
 * call produces good outputs under the locked directive.
 *
 * Flags:
 *   --sketch <path>      one sketch image. Default: auto-discover the only
 *                        image file at samples/v2-day-0-input/ top level.
 *   --styles <dir>       directory of style painting images. Default:
 *                        samples/v2-day-0-input/styles/
 *   --model flash|pro    model tier (default: pro — smoke runs the ceiling.
 *                        Production-default for Explore is Flash, but if
 *                        Pro outputs are bad, Flash will be worse.)
 *   --resolution 1k|4k   output resolution (default: 1k)
 *
 * Run:
 *   node --env-file=.env --import tsx scripts/smoke-style.ts [flags]
 *   npm run smoke-style -- [--sketch <path>] [--styles <dir>] \\
 *                          [--model flash|pro] [--resolution 1k|4k]
 *
 * Outputs:
 *   samples/v2-day-0/<sketch-slug>/<style-slug>.jpg     (one per style)
 *   samples/v2-day-0/<sketch-slug>/directives.json      (per-pair results)
 *
 * The directive is the locked Krea-validated template (do NOT change
 * without re-running the gate against multiple sketches):
 *
 *   "keep the character design exactly as is from image one but show a
 *    completed work in the completed style of image 2. keep the exact
 *    character style and shape."
 *
 * The aspect ratio sentence is appended per AGENTS.md §3 (output aspect
 * == input aspect; the SKETCH's aspect drives the call, never the style
 * painting's). The sketch is parts[0], style painting is parts[1], text
 * is parts[2]. Order is FIXED — the directive's "image one / image two"
 * language depends on it.
 *
 * No DB writes, no R2 uploads. Pairs are processed SEQUENTIALLY so the
 * terminal output reads cleanly as each pair completes (Pro 1K calls
 * ~10-30s; a 9-style batch runs ~3-5 min).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import sharp from "sharp";

import { callWithRetry } from "../lib/gemini/callWithRetry";
import { genai, IMAGE_MODEL_FLASH, IMAGE_MODEL_PRO } from "../lib/gemini/client";
import { extractImageBytes } from "../lib/gemini/extract";
import {
  nearestSupportedAspectRatio,
  type SupportedAspectRatio,
} from "../lib/gemini/aspectRatio";
import {
  buildStyleExplorePrompt,
  STYLE_EXPLORE_DIRECTIVE,
} from "../lib/gemini/imagePrompts";
import {
  costFor,
  pricePerImage,
  type ModelTier,
  type Resolution,
} from "../lib/cost";

const INPUT_DIR = resolve("samples/v2-day-0-input");
const STYLES_DIR_DEFAULT = resolve("samples/v2-day-0-input/styles");
const OUTPUT_ROOT = resolve("samples/v2-day-0");
const INPUT_LONG_EDGE_PX = 2048;
const INPUT_JPEG_QUALITY = 85;
const OUTPUT_JPEG_QUALITY = 90;

// Locked directive — Krea-validated by Jeff against Zuzi's character work.
// The single source of truth lives in `lib/gemini/imagePrompts.ts` as
// `STYLE_EXPLORE_DIRECTIVE` so the smoke gate's bytes match production's
// bytes. v2.0 inlined a duplicate; v2.2 promoted the constant into the
// shared module and we now re-import it.
//
// "character" wording is character-work-specific (confirmed with Jeff;
// Zuzi's practice is figurative). If her practice later expands to
// landscapes / still life / abstracts, this template needs a generalized
// variant — flag and re-run the gate.

interface ParsedArgs {
  sketchArg: string | undefined;
  stylesArg: string | undefined;
  modelTier: ModelTier;
  resolution: Resolution;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let modelTier: ModelTier = "pro";
  let resolution: Resolution = "1k";
  let sketchArg: string | undefined;
  let stylesArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const grab = (name: string): string => {
      if (a === name) {
        const v = args[++i];
        if (!v) throw new Error(`${name} expects a value`);
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return "";
    };
    let v = grab("--sketch");
    if (v) {
      sketchArg = v;
      continue;
    }
    v = grab("--styles");
    if (v) {
      stylesArg = v;
      continue;
    }
    v = grab("--model");
    if (v) {
      if (v !== "flash" && v !== "pro")
        throw new Error(`--model expects flash|pro, got: ${v}`);
      modelTier = v;
      continue;
    }
    v = grab("--resolution");
    if (v) {
      if (v !== "1k" && v !== "4k")
        throw new Error(`--resolution expects 1k|4k, got: ${v}`);
      resolution = v;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    }
    throw new Error(
      `Unexpected positional argument: ${a}. Use --sketch <path> and --styles <dir>.`,
    );
  }
  return { sketchArg, stylesArg, modelTier, resolution };
}

function isImageName(n: string): boolean {
  return /\.(jpe?g|png|webp|heic)$/i.test(n) && !n.startsWith(".");
}

async function pickSketch(arg: string | undefined): Promise<string> {
  if (arg) {
    const p = resolve(arg);
    if (!existsSync(p)) throw new Error(`Sketch not found: ${p}`);
    return p;
  }
  if (!existsSync(INPUT_DIR)) {
    throw new Error(
      `${INPUT_DIR} does not exist. See samples/v2-day-0-input/README.md for layout.`,
    );
  }
  const entries = (await readdir(INPUT_DIR)).filter(isImageName);
  if (entries.length === 0) {
    throw new Error(
      `No sketch images at the top level of ${INPUT_DIR}. Drop one in (e.g. sketch.jpg) or pass --sketch <path>.`,
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `Multiple sketch images at top level of ${INPUT_DIR}. Pass --sketch <path> explicitly.\nFound:\n  ${entries.join("\n  ")}`,
    );
  }
  return join(INPUT_DIR, entries[0]);
}

async function pickStyles(arg: string | undefined): Promise<string[]> {
  const dir = arg ? resolve(arg) : STYLES_DIR_DEFAULT;
  if (!existsSync(dir)) {
    throw new Error(
      `Styles dir not found: ${dir}. Create it and drop style paintings inside (or pass --styles <dir>).`,
    );
  }
  const entries = (await readdir(dir)).filter(isImageName).sort();
  if (entries.length === 0) {
    throw new Error(
      `No style images in ${dir}. Drop reference paintings (jpg/png/webp/heic) inside.`,
    );
  }
  return entries.map((n) => join(dir, n));
}

/** Slugify a filename for use in output paths / per-tile attribution. */
function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "untitled"
  );
}

/** Sharp-normalize one image to a 2048px-long-edge JPEG, return bytes +
 *  dims so callers can compute aspect ratio + decide the Gemini call's
 *  imageConfig. Mirrors the production /api/sources upload pipeline. */
async function prepImage(
  path: string,
): Promise<{ bytes: Buffer; base64: string; w: number; h: number }> {
  const raw = await readFile(path);
  const resized = await sharp(raw)
    .rotate()
    .resize(INPUT_LONG_EDGE_PX, INPUT_LONG_EDGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: INPUT_JPEG_QUALITY })
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w <= 0 || h <= 0) {
    throw new Error(`Invalid resized dimensions for ${path}: ${w}x${h}`);
  }
  return { bytes: resized, base64: resized.toString("base64"), w, h };
}

interface PairResult {
  style_file: string;
  style_slug: string;
  /** Mirrors what production stores in `tiles.prompt_used` for style_explore
   *  tiles — `"style: <title-or-slug>"`. Traceability marker; the directive
   *  itself is constant and lives in code. */
  prompt_used: string;
  success: boolean;
  cost_usd: number;
  wall_ms: number;
  output_file: string | null;
  detected_mime: string | null;
  error: string | null;
}

async function main() {
  const { sketchArg, stylesArg, modelTier, resolution } = parseArgs(
    process.argv,
  );
  const sketchPath = await pickSketch(sketchArg);
  const stylePaths = await pickStyles(stylesArg);

  const sketchSlug = slug(basename(sketchPath, extname(sketchPath)));
  const outDir = join(OUTPUT_ROOT, sketchSlug);
  await mkdir(outDir, { recursive: true });

  const modelId = modelTier === "flash" ? IMAGE_MODEL_FLASH : IMAGE_MODEL_PRO;
  const imageSize = resolution.toUpperCase(); // "1K" | "4K"
  const projectedCost = costFor(modelTier, resolution, stylePaths.length);
  const perImage = pricePerImage(modelTier, resolution);

  console.log("\n=== smoke-style run (v2.0 gate) ===");
  console.log(`sketch:     ${sketchPath}`);
  console.log(`styles dir: ${stylesArg ? resolve(stylesArg) : STYLES_DIR_DEFAULT}`);
  console.log(`style count: ${stylePaths.length}`);
  console.log(`output:     ${outDir}`);
  console.log(`model:      ${modelTier} ${resolution}  (${modelId})`);
  console.log(
    `est. cost:  $${projectedCost.toFixed(3)}  ($${perImage.toFixed(3)} × ${stylePaths.length})`,
  );
  console.log();

  // 1. Prep sketch once.
  console.log("preparing sketch (sharp 2048px / JPEG q85)...");
  const sketch = await prepImage(sketchPath);
  const aspectRatio: SupportedAspectRatio = nearestSupportedAspectRatio(
    sketch.w,
    sketch.h,
  );
  console.log(`  ${sketch.w}x${sketch.h} → snapped aspect ${aspectRatio}`);
  console.log(`  (${(sketch.bytes.length / 1024).toFixed(0)} KB after resize)\n`);

  // Per AGENTS.md §3: aspect ratio stated in prompt text AND passed via
  // config.imageConfig.aspectRatio. SKETCH's aspect — never the style
  // painting's. Style paintings are reference inputs whose own aspect is
  // ignored at the Gemini call level (they're inline data, not the
  // generation target).
  const promptText = buildStyleExplorePrompt(aspectRatio);

  // 2. Loop: prep each style, fire call, extract, write to disk.
  const tStart = performance.now();
  const results: PairResult[] = [];

  for (let i = 0; i < stylePaths.length; i++) {
    const stylePath = stylePaths[i];
    const styleFile = basename(stylePath);
    const styleSlug = slug(basename(stylePath, extname(stylePath)));
    const label = `[${i + 1}/${stylePaths.length}] ${styleFile}`;
    console.log(`${label} — prepping...`);

    let style: Awaited<ReturnType<typeof prepImage>>;
    try {
      style = await prepImage(stylePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  prep failed: ${msg}`);
      results.push({
        style_file: styleFile,
        style_slug: styleSlug,
        prompt_used: `style: ${styleSlug}`,
        success: false,
        cost_usd: 0,
        wall_ms: 0,
        output_file: null,
        detected_mime: null,
        error: `prep_failed: ${msg}`,
      });
      continue;
    }

    console.log(
      `  ${label} — calling ${modelId} (${style.w}x${style.h} reference)...`,
    );
    const tPair = performance.now();
    try {
      const resp = await callWithRetry(
        () =>
          genai().models.generateContent({
            model: modelId,
            contents: [
              {
                role: "user",
                parts: [
                  // Order is FIXED — sketch first (image one), style painting
                  // second (image two), then text. The directive references
                  // "image one" / "image 2" and depends on this order.
                  {
                    inlineData: {
                      mimeType: "image/jpeg",
                      data: sketch.base64,
                    },
                  },
                  {
                    inlineData: {
                      mimeType: "image/jpeg",
                      data: style.base64,
                    },
                  },
                  { text: promptText },
                ],
              },
            ],
            config: { imageConfig: { aspectRatio, imageSize } },
          }),
        { label: `smoke-style ${styleSlug}` },
      );

      const extracted = extractImageBytes(resp);
      // Re-encode to JPEG q90 to match production output format
      // (regardless of whether Gemini returned PNG or JPEG bytes).
      const jpeg = await sharp(extracted.bytes)
        .jpeg({ quality: OUTPUT_JPEG_QUALITY })
        .toBuffer();
      const outName = `${styleSlug}.jpg`;
      await writeFile(join(outDir, outName), jpeg);

      const wallMs = performance.now() - tPair;
      const cost = pricePerImage(modelTier, resolution);
      console.log(
        `  ✓ wrote ${outName}  (${(jpeg.length / 1024).toFixed(0)} KB, ${(wallMs / 1000).toFixed(1)}s, $${cost.toFixed(3)})`,
      );
      results.push({
        style_file: styleFile,
        style_slug: styleSlug,
        prompt_used: `style: ${styleSlug}`,
        success: true,
        cost_usd: cost,
        wall_ms: Math.round(wallMs),
        output_file: outName,
        detected_mime: extracted.detectedMime,
        error: null,
      });
    } catch (e) {
      const wallMs = performance.now() - tPair;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  ✗ FAILED in ${(wallMs / 1000).toFixed(1)}s: ${msg}`);
      // Write a .error.txt alongside so the failure is visible in the output
      // tree (mirrors smoke.ts pattern).
      await writeFile(
        join(outDir, `${styleSlug}.error.txt`),
        `style_file=${styleFile}\nerror=${msg}\n`,
      );
      results.push({
        style_file: styleFile,
        style_slug: styleSlug,
        prompt_used: `style: ${styleSlug}`,
        success: false,
        cost_usd: 0,
        wall_ms: Math.round(wallMs),
        output_file: null,
        detected_mime: null,
        error: msg,
      });
    }
  }

  // 3. Persist the per-pair record. directives.json is the manifest the
  // human (Jeff / Zuzi) eyeballs alongside the JPEGs to know which style
  // produced which output + how much it cost.
  const manifest = {
    sketch_file: basename(sketchPath),
    sketch_slug: sketchSlug,
    sketch_aspect_ratio: aspectRatio,
    model_id: modelId,
    model_tier: modelTier,
    resolution,
    directive: STYLE_EXPLORE_DIRECTIVE,
    aspect_ratio_sentence: `Match the input aspect ratio exactly (${aspectRatio}).`,
    started_at: new Date(Date.now() - (performance.now() - tStart)).toISOString(),
    pairs: results,
  };
  await writeFile(
    join(outDir, "directives.json"),
    JSON.stringify(manifest, null, 2),
  );

  // 4. Summary.
  const okCount = results.filter((r) => r.success).length;
  const failCount = results.length - okCount;
  const recordedCost = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const tWall = (performance.now() - tStart) / 1000;

  console.log("\n=== summary ===");
  console.log(`sketch:        ${sketchPath}`);
  console.log(`output dir:    ${outDir}`);
  console.log(`pairs:         ${okCount} ok / ${failCount} failed`);
  console.log(`wall time:     ${tWall.toFixed(1)}s`);
  console.log(
    `recorded cost: $${recordedCost.toFixed(3)}  (${okCount} successful calls × $${perImage.toFixed(3)})`,
  );
  console.log(`directive:     "${STYLE_EXPLORE_DIRECTIVE}"`);
  console.log(`manifest:      ${join(outDir, "directives.json")}\n`);

  if (failCount > 0) {
    console.log("failed pairs:");
    for (const r of results.filter((x) => !x.success)) {
      console.log(`  ${r.style_file}: ${r.error}`);
    }
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("\nsmoke-style failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
