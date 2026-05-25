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
import { flipAspectRatio } from "./aspectRatio";
import {
  buildPrompt,
  buildStyleBlendPrompt,
  buildStyleExplorePrompt,
} from "./imagePrompts";
import { callWithRetry } from "./callWithRetry";
import { extractImageBytes } from "./extract";
import { classifyError } from "./errors";
import { parseBlendStyleIdsJson, parseStoredPresets } from "./presets";
import * as bus from "../bus";
import { costForCompletedIteration } from "../cost";
import {
  failPendingTilesForIteration,
  getIteration,
  getSource,
  getStylePainting,
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

/**
 * Mark an iteration's status as 'failed' AND sweep every still-pending
 * tile to 'failed' with the same error message. Used by every worker
 * hard-fail early-return so the UI never sees an iteration='failed' +
 * tiles='pending' combination (which renders as permanently-loading
 * tiles under a terminal-status row — looks broken).
 *
 * Also emits a per-tile bus event for every swept tile so any
 * subscribed SSE client updates without waiting for the next /api/
 * iterations refetch. Idempotent — re-running on an already-failed
 * iteration is safe (failPendingTilesForIteration filters on
 * status='pending').
 */
function hardFailIteration(iterationId: string, errorMessage: string): void {
  // Snapshot the pending tiles BEFORE the DB sweep so we know which
  // ids to emit events for.
  const pendingTiles = tilesFor(iterationId).filter(
    (t) => t.status === "pending",
  );
  failPendingTilesForIteration(iterationId, errorMessage);
  updateIterationStatus(iterationId, "failed", Date.now());
  const truncated = errorMessage.slice(0, 500);
  for (const t of pendingTiles) {
    bus.emit(iterationId, {
      type: "tile",
      id: t.id,
      idx: t.idx,
      status: "failed",
      error: truncated,
    });
  }
}

/**
 * v3.0 Style Blend: resolve the output aspect ratio. Uses the FIRST
 * blend style's snapped aspect_ratio (per AGENTS.md §3 documented
 * exception — blend has no sketch, the sketch-aspect invariant doesn't
 * apply). Returns null if the first style row is missing — caller
 * hard-fails the iteration.
 */
async function resolveBlendAspectRatio(
  blendStyleIds: string[],
  iterationId: string,
): Promise<string | null> {
  if (blendStyleIds.length === 0) {
    console.error(
      `[runIteration ${iterationId}] style_blend with empty blend_style_ids — failing`,
    );
    return null;
  }
  const first = getStylePainting(blendStyleIds[0]);
  if (!first) {
    console.error(
      `[runIteration ${iterationId}] first blend style ${blendStyleIds[0]} missing — failing`,
    );
    return null;
  }
  return first.aspect_ratio;
}

async function runOneTile(
  iterationId: string,
  tileId: string,
  idx: number,
  /**
   * Ordered image inputs that go into the parts array BEFORE the
   * directive text. Mode-dependent composition:
   *   - prompt (no handoff):       [sketchBase64]
   *   - prompt + style handoff:    [sketchBase64, styleBase64]
   *   - style_explore:             [sketchBase64, styleBase64]
   *   - style_blend (v3.0):        [style1Base64, style2Base64, ..., styleNBase64]
   * The order is LOAD-BEARING — locked directives reference inputs by
   * position (e.g. STYLE_EXPLORE_DIRECTIVE references "image one / image
   * two"). Caller is responsible for composing the right ordering.
   */
  imageBase64s: string[],
  modelId: string,
  aspectRatio: string,
  imageSize: string,
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
    // Parts assembly: the caller-provided imageBase64s array first (in
    // its composition order — see runOneTile docstring on the param),
    // then the directive text. Order is FIXED and load-bearing because
    // locked directives reference inputs positionally (e.g.
    // STYLE_EXPLORE_DIRECTIVE: "image one / image two"). Reordering
    // the caller's array would silently invert the preserve target.
    const parts: Array<
      | { inlineData: { mimeType: string; data: string } }
      | { text: string }
    > = imageBase64s.map((data) => ({
      inlineData: { mimeType: "image/jpeg", data },
    }));
    parts.push({ text: promptText });

    const resp = await callWithRetry(
      () =>
        genai().models.generateContent({
          model: modelId,
          contents: [
            {
              role: "user",
              parts,
            },
          ],
          // `imageSize` was missing previously: requesting `resolution: "4k"`
          // billed at $0.24/img but Gemini defaulted to 1K output. SDK accepts
          // "1K" | "2K" | "4K" (uppercase) per @google/genai's ImageConfig
          // type; we send "1K" or "4K" depending on the per-iteration toggle.
          config: { imageConfig: { aspectRatio, imageSize } },
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
  // Wrap the entire orchestration in try/finally so `bus.emit({ type: 'done' })`
  // ALWAYS runs — even if the worker throws on a DB error in tilesFor() /
  // updateIterationStatus(), or any other unhandled exception in the
  // orchestration code itself. Without this, an SSE client subscribed to the
  // bus hangs until the 2-min stuck-banner timer fires.
  //
  // The per-tile try/catch in runOneTile() handles individual tile failures
  // and writes their status to the DB; this outer guard is purely the
  // catch-all for an exception in the surrounding orchestration. On such an
  // exception, we mark the iteration `failed` (so the UI shows truth) and
  // re-raise the error message into the upstream `.catch` log in
  // `app/api/iterate/route.ts`.
  let unhandledError: unknown = null;
  try {
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
      hardFailIteration(
        iterationId,
        `source not found: ${iter.source_id}`,
      );
      return;
    }

    // v3.0: parse blend_style_ids for style_blend iterations. Empty
    // array for every other mode (the column defaults to '[]'). The
    // worker fetches these styles' bytes below; the route guarantees
    // length ≥ 2 for valid style_blend iterations.
    const blendStyleIds =
      iter.mode === "style_blend"
        ? parseBlendStyleIdsJson(iter.blend_style_ids, iterationId)
        : [];

    // Source bytes are fetched for every mode EXCEPT style_blend —
    // blend is "pure style fusion, no sketch input" so the source
    // bytes are irrelevant to the Gemini call (the iteration row still
    // anchors to source_id for cascade + history, but the source is
    // not in parts[]). Skipping the fetch saves an R2 GET on every
    // blend iteration.
    let inputBase64: string | null = null;
    if (iter.mode !== "style_blend") {
      let inputBuffer: Buffer;
      try {
        inputBuffer = await getObject(source.input_image_key);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[runIteration ${iterationId}] r2.getObject failed:`,
          msg,
        );
        hardFailIteration(iterationId, `source r2 fetch failed: ${msg}`);
        return;
      }
      inputBase64 = inputBuffer.toString("base64");
    }

    const modelId =
      iter.model_tier === "flash" ? IMAGE_MODEL_FLASH : IMAGE_MODEL_PRO;
    // Source aspect ratio is the one snapped at upload (one of the 10
    // SUPPORTED_ASPECT_RATIOS values). Under flip mode, swap W:H so the
    // generated tile renders at the mirrored aspect; 1:1 stays 1:1. The
    // computed target ratio drives BOTH `imageConfig.aspectRatio` (so
    // the actual image bytes are at the right dimensions) AND the prompt's
    // `{aspectRatio}` interpolation (so Pro's preserve-the-aspect sentence
    // matches what we asked for) — the two MUST agree per AGENTS.md §3
    // "all three steps" invariant.
    //
    // For style_explore iterations the SKETCH wins — `source.aspect_ratio`
    // is still the canvas being completed, the style painting is the
    // reference whose own aspect is irrelevant to output dimensions.
    //
    // For style_blend (v3.0): no sketch exists. The output aspect comes
    // from the FIRST blend style painting's snapped aspect — this is
    // the documented exception to AGENTS.md §3's "output aspect ==
    // sketch aspect" invariant. Resolved a few lines below after we
    // pre-flight-check the blend styles exist.
    const aspectRatio =
      iter.mode === "style_blend"
        ? await resolveBlendAspectRatio(blendStyleIds, iterationId)
        : iter.aspect_ratio_mode === "flip"
          ? flipAspectRatio(source.aspect_ratio)
          : source.aspect_ratio;
    if (aspectRatio === null) {
      // Couldn't resolve a blend aspect (first style missing). Hard-fail
      // the iteration — blend with no usable references is meaningless.
      hardFailIteration(
        iterationId,
        "blend style missing (could not resolve output aspect ratio)",
      );
      return;
    }
    // SDK expects "1K" | "2K" | "4K" (uppercase). DB column is "1k" | "4k".
    const imageSize = iter.resolution.toUpperCase();

    // Per-mode prompt selection. style_explore mode short-circuits the
    // preset dominator ladder and uses the locked Krea-validated multi-
    // image directive. presets array is irrelevant in style_explore mode
    // (UI never sends presets with mode='style_explore'; the worker still
    // ignores them defensively).
    //
    // Prompt-mode "Iterate on this direction" handoff (v2.4): the route
    // copies the single stylePaintingId field onto EVERY tile of the new
    // iteration (uniform shape — all-or-none). When that's the case the
    // prompt body must be prepended with the style-reference sentence so
    // Pro knows the second image is the style anchor, not a second
    // sketch / compositional input.
    //
    // `.every()` (not `.some()`) is the load-bearing predicate: if a
    // mixed-mode iteration ever materializes (only possible via direct
    // DB write — the route guarantees uniform shape), `.some()` would
    // prepend the style-reference sentence to ALL tile prompts including
    // ones without a style image input, sending Pro contradictory
    // instructions. `.every()` falls through to the default no-prepend
    // path on mixed-mode, which is the predictable failure mode.
    const presets = parseStoredPresets(iter.presets, iterationId);
    // Single read of tilesFor — reused below for orchestration to avoid
    // wasted DB work and remove any race window between the two reads.
    const tileRowsForPromptDecision = tilesFor(iterationId);
    const promptModeHasStyleRef =
      iter.mode === "prompt" &&
      tileRowsForPromptDecision.length > 0 &&
      tileRowsForPromptDecision.every((t) => t.style_painting_id !== null);
    const promptText =
      iter.mode === "style_explore"
        ? buildStyleExplorePrompt(aspectRatio)
        : iter.mode === "style_blend"
          ? buildStyleBlendPrompt(aspectRatio)
          : buildPrompt({
              presets,
              aspectRatio,
              withStyleReference: promptModeHasStyleRef,
            });

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
    // Reuse the rows we already fetched for the prompt decision —
    // tilesFor() is idempotent but the second call would be wasted DB
    // work. (If the worker grows enough that re-reading mid-flight
    // becomes valuable for some race protection, this is the place to
    // split them again.)
    const tileRows = tileRowsForPromptDecision;
    const recoveryHits = new Map<number, { r2_key: string; thumb_key?: string }>();
    for (const t of tileRows) {
      if (t.status === "pending") {
        const hit = byIterIdx.get(`${iterationId}:${t.idx}`);
        if (hit) recoveryHits.set(t.idx, { r2_key: hit.r2_key, thumb_key: hit.thumb_key });
      }
    }

    // Pre-fetch style painting bytes for tiles that need a second image
    // input — covers two cases:
    //   1. style_explore mode: each tile carries its OWN style_painting_id
    //      (per-tile attribution from the route's stylePaintingIds array).
    //   2. prompt mode + handoff: every tile carries the SAME
    //      style_painting_id (the route copies the single handoff
    //      stylePaintingId field onto every tile). The promptModeHasStyleRef
    //      check above already detected this case for the prompt
    //      prepend; the same tile.style_painting_id drives the second
    //      image input here.
    //
    // One R2 GET per UNIQUE style id referenced by this iteration's
    // tiles — the cache deduplicates so a prompt-mode handoff with
    // 3 tiles all pointing at the same style id makes ONE R2 fetch,
    // not three. Missing rows (style hard-deleted between tile
    // materialization and worker run) leave the cache entry empty;
    // the tile then falls through to a fail path with a clear
    // error_message (the catch in runOneTile takes care of marking).
    //
    // Recovery hits skip the fetch entirely (they don't re-call Gemini)
    // so we filter to tiles WITHOUT a recovery hit.
    const styleBytesByPainting = new Map<string, string>();
    const needsStyleFetch =
      iter.mode === "style_explore" || promptModeHasStyleRef;
    if (needsStyleFetch) {
      const needed = new Set<string>();
      for (const t of tileRows) {
        if (recoveryHits.has(t.idx)) continue;
        if (t.status !== "pending") continue;
        if (t.style_painting_id) needed.add(t.style_painting_id);
      }
      for (const sid of needed) {
        const sp = getStylePainting(sid);
        if (!sp) {
          console.warn(
            `[runIteration ${iterationId}] style_painting ${sid} not found at worker time (deleted mid-flight?); tiles referencing it will fail`,
          );
          continue;
        }
        try {
          const bytes = await getObject(sp.input_image_key);
          styleBytesByPainting.set(sid, bytes.toString("base64"));
        } catch (e) {
          console.warn(
            `[runIteration ${iterationId}] r2.getObject failed for style ${sid} (${sp.input_image_key}):`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    }

    // v3.0 Style Blend: pre-fetch ALL N blend style bytes in order.
    // Different failure mode from style_explore — blend is a single
    // creative operation that needs every reference to make sense, so
    // if ANY blend style is missing or its R2 GET fails, we hard-fail
    // the iteration (vs style_explore's per-tile graceful skip).
    //
    // Skip the prefetch entirely when no tile actually needs to call
    // Gemini — i.e. every pending tile is in recoveryHits (boot-time
    // replay where R2 puts + recovery.jsonl appends succeeded but the
    // DB updates never landed; rehydration bypasses Gemini). Saves
    // N R2 GETs on every full-recovery boot replay of a blend
    // iteration. Mirrors the `if (recoveryHits.has(t.idx)) continue`
    // guard in the style_explore prefetch loop above.
    const blendPendingNonRecoveredCount = tileRows.filter(
      (t) => t.status === "pending" && !recoveryHits.has(t.idx),
    ).length;
    const blendStyleBase64s: string[] = [];
    if (iter.mode === "style_blend" && blendPendingNonRecoveredCount > 0) {
      for (const sid of blendStyleIds) {
        const sp = getStylePainting(sid);
        if (!sp) {
          console.error(
            `[runIteration ${iterationId}] blend_style ${sid} missing — failing iteration`,
          );
          hardFailIteration(
            iterationId,
            `blend style ${sid} missing at worker time`,
          );
          return;
        }
        try {
          const bytes = await getObject(sp.input_image_key);
          blendStyleBase64s.push(bytes.toString("base64"));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            `[runIteration ${iterationId}] r2.getObject failed for blend style ${sid}:`,
            msg,
          );
          hardFailIteration(
            iterationId,
            `blend style ${sid} r2 fetch failed: ${msg}`,
          );
          return;
        }
      }
    }

    updateIterationStatus(iterationId, "running");
    bus.emit(iterationId, { type: "started" });

    const results = await Promise.all(
      tileRows.map((t) => {
        // Compose the per-tile imageBase64s array. Three branches:
        //   1. style_blend: every tile uses the SAME N blend style
        //      bytes (sketch is irrelevant; not in parts[]). Pre-
        //      fetched above; just reuse.
        //   2. style_explore / prompt-handoff: [sketch, style] — sketch
        //      first, style second per the locked directive's "image
        //      one / image two" anchoring.
        //   3. plain prompt mode: [sketch] only.
        // For tiles whose style ref was hard-deleted mid-flight (case 2
        // only — case 1 hard-fails the iteration above), fall through
        // with sketch-only. Pro will likely fail extraction at the
        // bytes-sniff step (caught by classifyError) but the
        // error_message surfaces to the user either way.
        let imageBase64s: string[];
        if (iter.mode === "style_blend") {
          imageBase64s = blendStyleBase64s;
        } else {
          // inputBase64 is guaranteed non-null here (we hard-returned
          // above if the source bytes fetch failed for non-blend modes).
          const sketchB64 = inputBase64 as string;
          const styleB64 = t.style_painting_id
            ? styleBytesByPainting.get(t.style_painting_id) ?? null
            : null;
          imageBase64s = styleB64 ? [sketchB64, styleB64] : [sketchB64];
        }
        return runOneTile(
          iterationId,
          t.id,
          t.idx,
          imageBase64s,
          modelId,
          aspectRatio,
          imageSize,
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
        });
      }),
    );

    const successfulCount = results.filter((r) => r.ok).length;
    // Iteration status reflects truth: at least one successful tile = done;
    // zero successful (every tile blocked or failed) = the iteration as a
    // whole failed. Previously this was unconditionally "done" which made
    // fully-failed iterations look successful in the UI — confusing both for
    // Zuzi (no error indication) and for the worker's idempotent-replay
    // path (which checks `iter.status === "failed"` to bail early; that
    // check could never fire for worker-failed iterations).
    const finalStatus = successfulCount > 0 ? "done" : "failed";
    updateIterationStatus(iterationId, finalStatus, Date.now());
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
  } catch (e) {
    // Catch-all for orchestration code (DB errors in tilesFor / updateIterationStatus,
    // unexpected throws inside Promise.all, etc.). Per-tile failures are already
    // handled inside runOneTile and don't reach here. Try to mark the iteration
    // failed so the UI doesn't show a permanently-pending row; swallow any
    // secondary error from that update so the `done` emit in finally still fires.
    unhandledError = e;
    console.error(
      `[runIteration ${iterationId}] unhandled orchestration error:`,
      e instanceof Error ? e.message : e,
    );
    try {
      // Use the helper so any still-pending tile rows are also swept to
      // 'failed' — the orchestration catch fires when the iteration
      // setup itself crashed (e.g., tilesFor threw), in which case the
      // per-tile try/catch in runOneTile never got to mark tiles
      // failed. Without the sweep the UI shows iteration='failed' +
      // tiles='pending' = permanent loading animation.
      hardFailIteration(
        iterationId,
        e instanceof Error ? e.message : String(e),
      );
    } catch (innerErr) {
      console.error(
        `[runIteration ${iterationId}] failed to mark iteration failed in cleanup:`,
        innerErr instanceof Error ? innerErr.message : innerErr,
      );
    }
  } finally {
    // ALWAYS emit done. SSE clients subscribed to the bus hang otherwise.
    // The route's `.catch` log above will show the unhandled error message
    // if there was one — but the `done` emit here happens regardless so the
    // client can close cleanly and the user isn't stuck behind a 2-min
    // stuck-banner.
    bus.emit(iterationId, { type: "done" });
  }
  // Re-raise so the upstream `.catch` in app/api/iterate/route.ts gets the
  // informative log message it expects (`[runIteration ${id}] unhandled:`).
  if (unhandledError) {
    throw unhandledError instanceof Error
      ? unhandledError
      : new Error(String(unhandledError));
  }
}
