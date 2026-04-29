/**
 * The generation worker.
 *
 * Called fire-and-forget from `POST /api/iterate` (per AGENTS.md §5 Tier C item 9).
 * Reads the iteration row, fetches the source bytes from R2, fires `tile_count`
 * parallel image calls (same prompt — built from `iter.presets` — temperature 1.0
 * default), writes outputs + thumbs to R2, appends to recovery.jsonl, updates the tile
 * row, emits to the bus.
 *
 * Recovery semantics: `appendRecovery` runs AFTER the R2 puts succeed and BEFORE the
 * tile row is updated. A crash in that window is recoverable from `recovery.jsonl` at
 * boot — we won't double-pay Gemini for that image.
 *
 * Errors per tile are classified via `lib/gemini/errors.ts`. Safety blocks → tile
 * status `'blocked'`. Anything else → `'failed'` with the cause-chain summary in
 * `tiles.error_message`. Other tiles in the same iteration continue independently.
 */

import { Buffer } from "node:buffer";
import sharp from "sharp";

import { genai, IMAGE_MODEL_FLASH, IMAGE_MODEL_PRO } from "./client";
import { buildPrompt } from "./imagePrompts";
import { callWithRetry } from "./callWithRetry";
import { extractImageBytes } from "./extract";
import { classifyError } from "./errors";
import { parseStoredPresets } from "./presets";
import * as bus from "../bus";
import { costForCompletedIteration } from "../cost";
import {
  getIteration,
  getSource,
  insertUsageLog,
  tilesFor,
  updateIterationStatus,
  updateTile,
} from "../db/queries";
import { appendRecovery, scanRecovery } from "../recovery";
import { getObject, putObject } from "../storage/r2";

const OUTPUT_JPEG_QUALITY = 90;
const THUMB_LONG_EDGE_PX = 512;
const THUMB_WEBP_QUALITY = 80;

interface TileRunResult {
  idx: number;
  ok: boolean;
}

async function runOneTile(
  iterationId: string,
  tileId: string,
  idx: number,
  inputBase64: string,
  modelId: string,
  aspectRatio: string,
  promptText: string,
  recoveryHit: { r2_key: string; thumb_key?: string } | undefined,
): Promise<TileRunResult> {
  // If recovery has bytes for this tile, hydrate without calling Gemini.
  if (recoveryHit) {
    try {
      const outKey = recoveryHit.r2_key;
      const thumbKey =
        recoveryHit.thumb_key ??
        outKey.replace(/^outputs\//, "thumbs/").replace(/\.jpg$/, ".webp");
      updateTile(iterationId, idx, {
        status: "done",
        output_image_key: outKey,
        thumb_image_key: thumbKey,
        completed_at: Date.now(),
      });
      bus.emit(iterationId, {
        type: "tile",
        id: tileId,
        idx,
        status: "done",
        outputKey: outKey,
        thumbKey,
      });
      return { idx, ok: true };
    } catch (e) {
      console.warn(
        `[runIteration ${iterationId} #${idx}] recovery rehydrate failed; falling through to fresh call`,
        e,
      );
    }
  }

  try {
    const resp = await callWithRetry(
      () =>
        genai().models.generateContent({
          model: modelId,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/jpeg", data: inputBase64 } },
                { text: promptText },
              ],
            },
          ],
          config: { imageConfig: { aspectRatio } },
        }),
      { label: `iter ${iterationId}#${idx}` },
    );

    const extracted = extractImageBytes(resp);
    const jpeg = await sharp(extracted.bytes)
      .jpeg({ quality: OUTPUT_JPEG_QUALITY })
      .toBuffer();
    const thumb = await sharp(jpeg)
      .resize(THUMB_LONG_EDGE_PX, THUMB_LONG_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: THUMB_WEBP_QUALITY })
      .toBuffer();

    const outKey = `outputs/${iterationId}/${idx}.jpg`;
    const thumbKey = `thumbs/${iterationId}/${idx}.webp`;

    await Promise.all([
      putObject(outKey, jpeg, "image/jpeg"),
      putObject(thumbKey, thumb, "image/webp"),
    ]);

    // Recovery row written AFTER R2 success and BEFORE the DB update.
    await appendRecovery({
      iter_id: iterationId,
      idx,
      r2_key: outKey,
      thumb_key: thumbKey,
      ts: Date.now(),
    });

    updateTile(iterationId, idx, {
      status: "done",
      output_image_key: outKey,
      thumb_image_key: thumbKey,
      completed_at: Date.now(),
    });
    bus.emit(iterationId, {
      type: "tile",
      id: tileId,
      idx,
      status: "done",
      outputKey: outKey,
      thumbKey,
    });
    return { idx, ok: true };
  } catch (e) {
    const classified = classifyError(e);
    const status: "blocked" | "failed" =
      classified.classification === "safety" ? "blocked" : "failed";
    const errorMessage = classified.message.slice(0, 500);
    updateTile(iterationId, idx, {
      status,
      error_message: errorMessage,
      completed_at: Date.now(),
    });
    bus.emit(iterationId, {
      type: "tile",
      id: tileId,
      idx,
      status,
      error: errorMessage,
    });
    return { idx, ok: false };
  }
}

export async function runIteration(iterationId: string): Promise<void> {
  const iter = getIteration(iterationId);
  if (!iter) {
    console.error(`[runIteration] iteration not found: ${iterationId}`);
    return;
  }
  if (iter.status === "done" || iter.status === "failed") {
    // Idempotent replay — nothing to do.
    return;
  }

  const source = getSource(iter.source_id);
  if (!source) {
    console.error(
      `[runIteration ${iterationId}] source not found: ${iter.source_id}`,
    );
    updateIterationStatus(iterationId, "failed", Date.now());
    bus.emit(iterationId, { type: "done" });
    return;
  }

  let inputBuffer: Buffer;
  try {
    inputBuffer = await getObject(source.input_image_key);
  } catch (e) {
    console.error(
      `[runIteration ${iterationId}] r2.getObject failed:`,
      e instanceof Error ? e.message : e,
    );
    updateIterationStatus(iterationId, "failed", Date.now());
    bus.emit(iterationId, { type: "done" });
    return;
  }
  const inputBase64 = inputBuffer.toString("base64");
  const modelId =
    iter.model_tier === "flash" ? IMAGE_MODEL_FLASH : IMAGE_MODEL_PRO;
  const aspectRatio = source.aspect_ratio;
  const presets = parseStoredPresets(iter.presets, iterationId);
  const promptText = buildPrompt({ presets, aspectRatio });

  // TEMP DEBUG (remove after Ambiance v8 deploy verification): on any iteration
  // that includes 'ambiance', log the Railway commit SHA + the rendered prompt
  // head so we can confirm production is sending v8 ("Continue this painting...")
  // and not a stale v1 ("Look at this painting and identify..."). Tagged with
  // [AMBIANCE_DEBUG] for grep in Railway runtime logs.
  if (presets.includes("ambiance")) {
    const sha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown").slice(0, 12);
    console.log(
      `[AMBIANCE_DEBUG ${iterationId}] sha=${sha} presets=${JSON.stringify(presets)} prompt[0..200]=${JSON.stringify(promptText.slice(0, 200))}`,
    );
  }

  // Recovery rehydration — only matters for boot-time replays where the iteration row
  // already exists with pending tiles. Map by `(iter_id, idx)` is keyed for O(1) lookup.
  const { byIterIdx } = await scanRecovery();
  const tileRows = tilesFor(iterationId);
  const recoveryHits = new Map<number, { r2_key: string; thumb_key?: string }>();
  for (const t of tileRows) {
    if (t.status === "pending") {
      const hit = byIterIdx.get(`${iterationId}:${t.idx}`);
      if (hit) recoveryHits.set(t.idx, { r2_key: hit.r2_key, thumb_key: hit.thumb_key });
    }
  }

  updateIterationStatus(iterationId, "running");
  bus.emit(iterationId, { type: "started" });

  const results = await Promise.all(
    tileRows.map((t) =>
      runOneTile(
        iterationId,
        t.id,
        t.idx,
        inputBase64,
        modelId,
        aspectRatio,
        promptText,
        recoveryHits.get(t.idx),
      ).catch((e): TileRunResult => {
        // Defensive: runOneTile already swallows its own errors. This is for the
        // truly unexpected (e.g., the catch handler itself throwing).
        console.error(
          `[runIteration ${iterationId}] unhandled in tile ${t.idx}:`,
          e,
        );
        return { idx: t.idx, ok: false };
      }),
    ),
  );

  const successfulCount = results.filter((r) => r.ok).length;
  updateIterationStatus(iterationId, "done", Date.now());
  if (successfulCount > 0) {
    insertUsageLog(
      iterationId,
      costForCompletedIteration(
        iter.model_tier,
        iter.resolution,
        successfulCount,
      ),
    );
  }
  bus.emit(iterationId, { type: "done" });
}
