/**
 * Smoke run — 9 parallel "make this beautiful" calls.
 *
 * Per AGENTS.md "Make this beautiful tool":
 *   The model is given the input painting and asked to reimagine it with new colors of
 *   its own choosing. Same prompt, 9 parallel calls, temperature default (1.0) so each
 *   call produces a different result. No planner, no directive set.
 *
 * Pipeline:
 *   1. Pick a painting from samples/inputs/ (or first positional CLI arg).
 *   2. Pre-resize via sharp to 2048px long edge @ JPEG q85, normalize EXIF rotation.
 *      Compute aspect ratio from the resized buffer.
 *   3. Fire 9 parallel image calls against the model tier selected by --model
 *      (default: pro = gemini-3-pro-image-preview; --model flash uses
 *      gemini-3.1-flash-image-preview). Same prompt for all 9. Aspect ratio passed via
 *      `config.imageConfig.aspectRatio` AND stated in the prompt. Image bytes extracted
 *      via shared `lib/gemini/extract.ts` (magic-byte sniff). Bytes converted to JPEG
 *      q90 via sharp before write.
 *   4. Save 9 .jpg (or .error.txt for failed tiles) to samples/day-0/<sketch-name>/.
 *   5. Print wall time and cost (computed from `lib/cost.ts` for the selected tier).
 *
 * Flags:
 *   --model flash|pro    Which tier to call. Defaults to `pro`. Both forms accepted:
 *                        `--model flash` and `--model=flash`.
 *
 * Run:
 *   node --env-file=.env --import tsx scripts/smoke.ts [path] [--model flash|pro]
 *   npm run smoke -- [path] [--model flash|pro]
 *
 * Examples:
 *   npm run smoke -- samples/inputs/foo.jpeg                 # Pro (default)
 *   npm run smoke -- samples/inputs/foo.jpeg --model flash   # Flash regression
 *   npm run smoke -- --model=pro samples/inputs/foo.jpeg     # equivalent
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import sharp from "sharp";

import {
  genai,
  IMAGE_MODEL_FLASH,
  IMAGE_MODEL_PRO,
} from "../lib/gemini/client";
import { buildImagePrompt } from "../lib/gemini/imagePrompt";
import {
  nearestSupportedAspectRatio,
  type SupportedAspectRatio,
} from "../lib/gemini/aspectRatio";
import { extractImageBytes } from "../lib/gemini/extract";
import {
  classifyError,
  formatClassifiedError,
  type ClassifiedError,
} from "../lib/gemini/errors";
import {
  pricePerImage,
  type ModelTier,
  type Resolution,
} from "../lib/cost";

const INPUTS_DIR = resolve("samples/inputs");
const DAY0_DIR = resolve("samples/day-0");

const INPUT_LONG_EDGE_PX = 2048;
const INPUT_JPEG_QUALITY = 85;
const OUTPUT_JPEG_QUALITY = 90;
const N_TILES = 9;
const SMOKE_RESOLUTION: Resolution = "1k";

interface ResolvedModel {
  tier: ModelTier;
  modelId: string;
}

function resolveModel(tier: ModelTier): ResolvedModel {
  return {
    tier,
    modelId: tier === "flash" ? IMAGE_MODEL_FLASH : IMAGE_MODEL_PRO,
  };
}

interface ParsedArgs {
  inputArg: string | undefined;
  modelTier: ModelTier;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let modelTier: ModelTier = "pro";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") {
      const v = args[++i];
      if (v !== "flash" && v !== "pro") {
        throw new Error(`--model expects "flash" or "pro", got: ${v ?? "(missing)"}`);
      }
      modelTier = v;
    } else if (a.startsWith("--model=")) {
      const v = a.slice("--model=".length);
      if (v !== "flash" && v !== "pro") {
        throw new Error(`--model expects "flash" or "pro", got: ${v}`);
      }
      modelTier = v;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. Supported: --model flash|pro`);
    } else {
      positional.push(a);
    }
  }
  return { inputArg: positional[0], modelTier };
}

function isImageName(n: string): boolean {
  return /\.(jpe?g|png|webp|heic)$/i.test(n) && !n.startsWith(".");
}

async function pickInput(arg: string | undefined): Promise<string> {
  if (arg) {
    const path = resolve(arg);
    if (!existsSync(path)) throw new Error(`Input not found: ${path}`);
    return path;
  }
  if (!existsSync(INPUTS_DIR)) {
    throw new Error(
      `samples/inputs/ does not exist. Create it and drop a painting in.`,
    );
  }
  const entries = (await readdir(INPUTS_DIR)).filter(isImageName);
  if (entries.length === 0) {
    throw new Error(
      `No images at the top level of samples/inputs/. Drop a painting there or pass a path as the first arg.`,
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `Multiple images in samples/inputs/. Pass one explicitly:\n  npm run smoke -- samples/inputs/<name>\nFound:\n  ${entries.join("\n  ")}`,
    );
  }
  return join(INPUTS_DIR, entries[0]);
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

interface PreparedInput {
  base64: string;
  bytes: number;
  width: number;
  height: number;
  aspectRatio: SupportedAspectRatio;
  originalDimensions: { width: number; height: number; bytes: number };
}

async function prepareInput(inputPath: string): Promise<PreparedInput> {
  const raw = await readFile(inputPath);
  const originalMeta = await sharp(raw).metadata();
  const originalDimensions = {
    width: originalMeta.width ?? 0,
    height: originalMeta.height ?? 0,
    bytes: raw.length,
  };

  const resized = await sharp(raw)
    .rotate() // EXIF orientation
    .resize(INPUT_LONG_EDGE_PX, INPUT_LONG_EDGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: INPUT_JPEG_QUALITY })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`Resized image has invalid dimensions: ${width}x${height}`);
  }
  return {
    base64: resized.toString("base64"),
    bytes: resized.length,
    width,
    height,
    aspectRatio: nearestSupportedAspectRatio(width, height),
    originalDimensions,
  };
}

type ImgResult =
  | {
      idx: number;
      ok: true;
      bytes: Buffer;
      ms: number;
      declaredMime: string | null;
      detectedMime: string;
    }
  | { idx: number; ok: false; error: ClassifiedError; ms: number };

async function generateOne(
  idx: number,
  input: PreparedInput,
  model: ResolvedModel,
): Promise<ImgResult> {
  const t0 = performance.now();
  try {
    const resp = await genai.models.generateContent({
      model: model.modelId,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: input.base64 } },
            { text: buildImagePrompt(input.aspectRatio) },
          ],
        },
      ],
      config: {
        imageConfig: { aspectRatio: input.aspectRatio },
      },
    });
    const extracted = extractImageBytes(resp);
    return {
      idx,
      ok: true,
      bytes: extracted.bytes,
      ms: performance.now() - t0,
      declaredMime: extracted.declaredMime,
      detectedMime: extracted.detectedMime,
    };
  } catch (e) {
    return {
      idx,
      ok: false,
      error: classifyError(e),
      ms: performance.now() - t0,
    };
  }
}

async function main() {
  const { inputArg, modelTier } = parseArgs(process.argv);
  const model = resolveModel(modelTier);
  const inputPath = await pickInput(inputArg);
  const sketchName = slug(basename(inputPath, extname(inputPath))) || "untitled";
  const outDir = join(DAY0_DIR, sketchName);
  await mkdir(outDir, { recursive: true });

  const perImage = pricePerImage(model.tier, SMOKE_RESOLUTION);
  const perGrid = perImage * N_TILES;

  console.log("\n=== smoke run ===");
  console.log(`input:  ${inputPath}`);
  console.log(`output: ${outDir}`);
  console.log(`model:  ${model.modelId} (${model.tier})`);
  console.log(`res:    ${SMOKE_RESOLUTION}`);
  console.log(
    `cost:   $${perImage.toFixed(3)}/img · $${perGrid.toFixed(2)}/grid\n`,
  );

  const tStart = performance.now();

  console.log("preparing input (sharp resize -> JPEG q85, EXIF rotate)...");
  const input = await prepareInput(inputPath);
  console.log(
    `  source:  ${input.originalDimensions.width}x${input.originalDimensions.height} (${(input.originalDimensions.bytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  console.log(
    `  resized: ${input.width}x${input.height} (${(input.bytes / 1024).toFixed(0)} KB)`,
  );
  console.log(`  aspect:  ${input.aspectRatio}\n`);

  console.log(`generating ${N_TILES} images in parallel (same prompt for all)...`);
  const tImg0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: N_TILES }, (_, idx) => generateOne(idx, input, model)),
  );
  const tImg = ((performance.now() - tImg0) / 1000).toFixed(1);

  const mimeMismatches: string[] = [];

  for (const r of results) {
    const num = String(r.idx + 1).padStart(2, "0");
    if (r.ok) {
      const jpeg = await sharp(r.bytes)
        .jpeg({ quality: OUTPUT_JPEG_QUALITY })
        .toBuffer();
      await writeFile(join(outDir, `tile-${num}.jpg`), jpeg);
      if (r.declaredMime && r.declaredMime !== r.detectedMime) {
        mimeMismatches.push(
          `tile ${r.idx + 1}: declared ${r.declaredMime}, actual ${r.detectedMime}`,
        );
      }
    } else {
      await writeFile(
        join(outDir, `tile-${num}.error.txt`),
        formatClassifiedError(r.error) + "\n",
      );
    }
  }

  const tWall = ((performance.now() - tStart) / 1000).toFixed(1);
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const cost = okCount * perImage;

  console.log("\n=== summary ===");
  console.log(`images generated:   ${okCount} ok, ${failCount} failed`);
  console.log(`wall time:          ${tWall}s  (images ${tImg}s)`);
  console.log(
    `cost:               ~$${cost.toFixed(2)} (${okCount} x $${perImage.toFixed(3)} ${model.tier} ${SMOKE_RESOLUTION})`,
  );
  console.log(`output:             ${outDir}\n`);

  if (mimeMismatches.length > 0) {
    console.log(`MIME mismatches (Google declared ≠ actual bytes):`);
    for (const m of mimeMismatches) console.log(`  ${m}`);
    console.log();
  }

  if (failCount > 0) {
    console.log("failed tiles:");
    for (const r of results) {
      if (!r.ok) {
        console.log(`  ${r.idx + 1}: ${formatClassifiedError(r.error)}`);
      }
    }
    console.log();
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("\nsmoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
