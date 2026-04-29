/**
 * Smoke run — full generation pipeline regression test.
 *
 * Per AGENTS.md §5 Tier C item 14: smoke now exercises the same code path the
 * production worker uses. It:
 *   1. Pre-resizes the input via sharp (mirrors POST /api/sources).
 *   2. INSERTs a `sources` row + `iterations` row + 9 pending `tiles` rows.
 *   3. Calls `runIteration(iterationId)` directly — same worker the route handler
 *      fires fire-and-forget. Exercises Gemini calls, callWithRetry, R2 puts,
 *      recovery.jsonl appends, bus events, tile updates, usage_log writes.
 *   4. Downloads the resulting outputs from R2 back to `samples/day-0/<slug>/` so
 *      the regression baseline lives in committed git artifacts (the R2 ULID
 *      keys are ephemeral; the local files are the durable record).
 *   5. Prints wall time and recorded cost from usage_log.
 *
 * Flags:
 *   --model flash|pro     model tier (default: pro)
 *   --resolution 1k|4k    output resolution (default: 1k)
 *
 * Run:
 *   node --env-file=.env --import tsx scripts/smoke.ts [path] [flags]
 *   npm run smoke -- [path] [--model flash|pro] [--resolution 1k|4k]
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import sharp from "sharp";
import { ulid } from "ulid";

import { db } from "../lib/db/client";
import {
  insertIterationAndTiles,
  insertSource,
  monthlyUsageUsd,
  tilesFor,
} from "../lib/db/queries";
import { iterations, usage_log } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import {
  nearestSupportedAspectRatio,
  type SupportedAspectRatio,
} from "../lib/gemini/aspectRatio";
import { runIteration } from "../lib/gemini/runIteration";
import { getObject, putObject } from "../lib/storage/r2";
import { pricePerImage, type ModelTier, type Resolution } from "../lib/cost";

const INPUTS_DIR = resolve("samples/inputs");
const DAY0_DIR = resolve("samples/day-0");
const INPUT_LONG_EDGE_PX = 2048;
const INPUT_JPEG_QUALITY = 85;

interface ParsedArgs {
  inputArg: string | undefined;
  modelTier: ModelTier;
  resolution: Resolution;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let modelTier: ModelTier = "pro";
  let resolution: Resolution = "1k";
  const positional: string[] = [];
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
    let v = grab("--model");
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
    positional.push(a);
  }
  return { inputArg: positional[0], modelTier, resolution };
}

function isImageName(n: string): boolean {
  return /\.(jpe?g|png|webp|heic)$/i.test(n) && !n.startsWith(".");
}

async function pickInput(arg: string | undefined): Promise<string> {
  if (arg) {
    const p = resolve(arg);
    if (!existsSync(p)) throw new Error(`Input not found: ${p}`);
    return p;
  }
  if (!existsSync(INPUTS_DIR)) {
    throw new Error(`samples/inputs/ does not exist`);
  }
  const entries = (await readdir(INPUTS_DIR)).filter(isImageName);
  if (entries.length === 0) {
    throw new Error(`No images at the top level of samples/inputs/`);
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

async function main() {
  const { inputArg, modelTier, resolution } = parseArgs(process.argv);
  const inputPath = await pickInput(inputArg);
  const sketchSlug = slug(basename(inputPath, extname(inputPath))) || "untitled";
  const outDir = join(DAY0_DIR, sketchSlug);
  await mkdir(outDir, { recursive: true });

  console.log("\n=== smoke run ===");
  console.log(`input:      ${inputPath}`);
  console.log(`output:     ${outDir}`);
  console.log(`model:      ${modelTier} ${resolution}`);
  console.log(
    `est. cost:  $${(pricePerImage(modelTier, resolution) * 9).toFixed(2)} (9 images)`,
  );
  console.log();

  const tStart = performance.now();

  // 1. Pre-resize input
  console.log("preparing input (sharp 2048px / JPEG q85)...");
  const raw = await readFile(inputPath);
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
  if (w <= 0 || h <= 0) throw new Error(`invalid resized dimensions: ${w}x${h}`);
  const aspectRatio: SupportedAspectRatio = nearestSupportedAspectRatio(w, h);
  console.log(
    `  source:  ${(meta.size ?? raw.length) ? "" : ""}${(raw.length / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`  resized: ${w}x${h}, ${(resized.length / 1024).toFixed(0)} KB`);
  console.log(`  aspect:  ${aspectRatio}\n`);

  // 2. Upload + insert source
  const sourceId = ulid();
  const inputKey = `inputs/${sourceId}.jpg`;
  console.log(`uploading source to R2 at ${inputKey}...`);
  await putObject(inputKey, resized, "image/jpeg");
  insertSource({
    id: sourceId,
    input_image_key: inputKey,
    original_filename: basename(inputPath),
    w,
    h,
    aspect_ratio: aspectRatio,
    created_at: Date.now(),
    archived_at: null,
  });
  console.log(`  source row inserted (id=${sourceId})\n`);

  // 3. Insert iteration + 9 pending tiles
  const iterationId = ulid();
  const requestId = ulid(); // smoke generates its own
  const now = Date.now();
  insertIterationAndTiles(
    {
      id: iterationId,
      request_id: requestId,
      source_id: sourceId,
      model_tier: modelTier,
      resolution,
      status: "pending",
      created_at: now,
      completed_at: null,
    },
    Array.from({ length: 9 }, (_, idx) => ({
      id: ulid(),
      iteration_id: iterationId,
      idx,
      output_image_key: null,
      thumb_image_key: null,
      status: "pending" as const,
      error_message: null,
      is_favorite: 0,
      favorited_at: null,
      created_at: now,
      completed_at: null,
    })),
  );
  console.log(
    `iteration ${iterationId} created with 9 pending tiles\nfiring runIteration...\n`,
  );

  // 4. Call the worker directly (same code path as POST /api/iterate)
  const tWorker = performance.now();
  await runIteration(iterationId);
  const tWorkerSeconds = (performance.now() - tWorker) / 1000;

  // 5. Download outputs from R2 to samples/day-0/<slug>/ for the regression baseline
  const tilesAfter = tilesFor(iterationId);
  const okCount = tilesAfter.filter((t) => t.status === "done").length;
  const failCount = tilesAfter.filter((t) => t.status !== "done").length;

  console.log(
    `\nworker done in ${tWorkerSeconds.toFixed(1)}s — ${okCount} ok, ${failCount} failed`,
  );
  console.log(`downloading outputs to ${outDir}...`);

  for (const t of tilesAfter) {
    const num = String(t.idx + 1).padStart(2, "0");
    if (t.status === "done" && t.output_image_key) {
      try {
        const bytes = await getObject(t.output_image_key);
        await writeFile(join(outDir, `tile-${num}.jpg`), bytes);
      } catch (e) {
        console.warn(
          `  tile ${num}: download failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } else {
      const detail = t.error_message ?? `(no error message; status=${t.status})`;
      await writeFile(
        join(outDir, `tile-${num}.error.txt`),
        `status=${t.status}\n${detail}\n`,
      );
    }
  }

  // 6. Read cost from usage_log
  const usageRow = db()
    .select()
    .from(usage_log)
    .where(eq(usage_log.iteration_id, iterationId))
    .get();
  const recordedCost = usageRow?.cost_usd ?? 0;
  const monthTotal = monthlyUsageUsd();

  // Verify iteration row marked done
  const iterRow = db()
    .select()
    .from(iterations)
    .where(eq(iterations.id, iterationId))
    .get();

  const tWall = (performance.now() - tStart) / 1000;

  console.log("\n=== summary ===");
  console.log(`source_id:     ${sourceId}`);
  console.log(`iteration_id:  ${iterationId}  (status=${iterRow?.status})`);
  console.log(
    `tiles:         ${okCount} ok / ${failCount} failed`,
  );
  console.log(
    `wall time:     ${tWall.toFixed(1)}s (worker ${tWorkerSeconds.toFixed(1)}s)`,
  );
  console.log(
    `recorded cost: $${recordedCost.toFixed(3)}  (this iteration, from usage_log)`,
  );
  console.log(
    `month total:   $${monthTotal.toFixed(3)}  (calendar month UTC)`,
  );
  console.log(`output dir:    ${outDir}\n`);

  if (failCount > 0) {
    console.log("failed tiles:");
    for (const t of tilesAfter) {
      if (t.status !== "done")
        console.log(`  ${t.idx + 1}: ${t.status} — ${t.error_message ?? ""}`);
    }
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("\nsmoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
