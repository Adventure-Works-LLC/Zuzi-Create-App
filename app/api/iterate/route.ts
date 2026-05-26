/**
 * POST /api/iterate — kick off an N-tile generation against a source.
 *
 * Body: {requestId, sourceId, modelTier?, resolution?, count?, presets?,
 *        mode?, stylePaintingIds?, parentTileId?}
 *   - requestId: client-supplied ulid for idempotency. Replays return the same
 *     iterationId.
 *   - sourceId: must reference an existing sources row.
 *   - modelTier: 'flash' | 'pro' (default 'pro' per AGENTS.md §4)
 *   - resolution: '1k' | '4k' (default '1k')
 *   - count: integer in [1, TILE_COUNT_MAX]; default TILE_COUNT_DEFAULT.
 *     Number of tiles to generate. Persisted on `iterations.tile_count`.
 *     IGNORED when mode='style_explore' — the stylePaintingIds array
 *     length is authoritative (one tile per style painting in the batch).
 *   - presets: array of preset strings, subset of PRESETS (color, ambiance,
 *     lighting, background, avery, etching). Default []. Persisted as JSON
 *     on `iterations.presets`. Determines the prompt via
 *     `lib/gemini/imagePrompts.ts buildPrompt()`. IGNORED at the worker
 *     when mode='style_explore' (the locked directive bypasses the preset
 *     dominator ladder); still accepted defensively so a malformed client
 *     can't crash the route.
 *   - mode: 'prompt' (default) | 'style_explore'. Discriminates the worker
 *     branch — see lib/gemini/runIteration.ts.
 *   - stylePaintingIds: required when mode='style_explore'. Non-empty
 *     array of style_paintings ids, ≤ TILE_COUNT_MAX entries, one per
 *     tile (index alignment — tile.idx i maps to stylePaintingIds[i]).
 *     Determines tile_count for the batch. REJECTED in prompt mode (use
 *     `stylePaintingId` instead).
 *   - stylePaintingId: optional in prompt mode. A SINGLE style painting
 *     id that gets copied to every tile.style_painting_id of the new
 *     iteration. The worker then includes the style painting as second
 *     image input on every tile AND prepends a style-reference sentence
 *     to the preset body. Used by the v2.4 lightbox "Iterate on this
 *     direction" handoff so refinement passes can carry the seed
 *     direction forward. REJECTED in style_explore mode (use the
 *     array `stylePaintingIds` instead).
 *   - parentTileId: optional. When set, the iteration carries provenance
 *     back to a style_explore tile via iterations.parent_tile_id (the
 *     "Iterate on this direction" handoff). Valid in either mode;
 *     v2.4 wires it from the lightbox in prompt-mode only.
 *
 * Returns:
 *   - First write: { iterationId }
 *   - Idempotent replay (early short-circuit OR UNIQUE collision):
 *       { iterationId, idempotentReplay: true, count, presets, aspectRatioMode,
 *         mode, parentTileId }
 *     where echoed fields reflect the ORIGINAL row's values, NOT the
 *     retry's body. The client reconciles its optimistic placeholder
 *     skeleton against these fields in `hooks/useIterations.ts` so a
 *     retry whose body differed renders the right number of tiles, the
 *     right preset chips, AND the right effective aspect ratio (the SSE
 *     worker uses the original row's aspect_ratio_mode regardless of
 *     what the retry body said, so the client must follow suit or every
 *     tile thumb will render with the wrong aspect-ratio container).
 *
 * Idempotency: iterations.request_id is UNIQUE. Concurrent retries with the same
 * requestId hit the constraint and we return the existing iteration's id.
 *
 * Worker is fire-and-forget (per AGENTS.md §5). Response returns immediately;
 * runIteration runs in the background and emits tile events on the bus. SSE
 * subscribers pick them up.
 */

import { NextResponse } from "next/server";
import { ulid } from "ulid";

import { requireAuth } from "@/lib/auth/requireAuth";
import {
  findIterationByRequestId,
  getIteration,
  getSource,
  getStylePainting,
  getTile,
  insertIterationAndTiles,
  monthlyUsageUsd,
} from "@/lib/db/queries";
import { PRESETS, type Preset } from "@/lib/db/schema";
import { runIteration } from "@/lib/gemini/runIteration";
import {
  MAX_BLEND_TILES,
  TILE_COUNT_DEFAULT,
  TILE_COUNT_MAX,
} from "@/lib/gemini/imagePrompts";
import {
  parseBlendTileIdsJson,
  parseStoredPresets,
} from "@/lib/gemini/presets";
import { costFor } from "@/lib/cost";

export const runtime = "nodejs";

// Hard monthly cap on Gemini spend. Default $80; bumpable via env var.
// NaN-guarded: a non-numeric env value (e.g. "" or "lots", easy to fat-finger
// in the Railway dashboard) would otherwise produce NaN and silently disable
// the cap entirely (any monthSoFar + projected > NaN === false). Coerce
// through `Number.isFinite` and fall back to 80 on anything non-positive
// or non-numeric. Zero is also treated as misconfigured — a literal 0 cap
// would block every iteration; callers who want "off" can set a very large
// number, but the safer default is the documented $80.
const _capParsed = Number(process.env.MONTHLY_USD_CAP ?? "80");
const MONTHLY_USD_CAP =
  Number.isFinite(_capParsed) && _capParsed > 0 ? _capParsed : 80;

/** Parse + validate the `presets` field. Returns a deduped, stably-ordered
 * Preset[] (matching the order in PRESETS). Throws on bad input so the route
 * can return a clean 400. */
function parsePresets(raw: unknown): Preset[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("presets_must_be_array");
  const allowed = new Set<string>(PRESETS);
  const seen = new Set<Preset>();
  for (const v of raw) {
    if (typeof v !== "string" || !allowed.has(v)) {
      throw new Error(`invalid_preset:${String(v).slice(0, 40)}`);
    }
    seen.add(v as Preset);
  }
  // Stable canonical order, deduped.
  return PRESETS.filter((p) => seen.has(p));
}

/** Parse + validate the `count` field. Returns an integer in [1,
 * TILE_COUNT_MAX]. Throws on bad input. */
function parseCount(raw: unknown): number {
  if (raw === undefined || raw === null) return TILE_COUNT_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error("count_must_be_integer");
  }
  if (raw < 1 || raw > TILE_COUNT_MAX) {
    throw new Error(`count_out_of_range:1..${TILE_COUNT_MAX}`);
  }
  return raw;
}

/** Parse + validate the optional `stylePaintingIds` field. Returns a string[]
 * of length [1, TILE_COUNT_MAX], or null when absent. Strings are NOT
 * format-validated as ulids — the worker handles missing rows gracefully
 * via getStylePainting + skip-on-miss, so the validation cost here would
 * mostly be defensive vs. typos. Throws on bad type / out-of-range size.
 *
 * Duplicates are INTENTIONALLY accepted, NOT rejected. The v2.7 "More
 * like this" Lightbox button uses this path with `[id, id, id]` to fire
 * N pure-variation tiles against the same (sketch + style) pair (the
 * locked STYLE_EXPLORE_DIRECTIVE produces different outputs at
 * temperature 1.0 even for identical inputs). The worker already
 * dedupes the R2 prefetch via Set<string>, so an N-tile drill against
 * the same style makes ONE R2 GET regardless of N. Don't add a
 * uniqueness check here — it would break "More like this". */
function parseStylePaintingIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error("stylePaintingIds_must_be_array");
  if (raw.length === 0) {
    throw new Error("stylePaintingIds_empty");
  }
  if (raw.length > TILE_COUNT_MAX) {
    throw new Error(`stylePaintingIds_too_many:max_${TILE_COUNT_MAX}`);
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.length === 0 || v.length > 64) {
      throw new Error(
        `invalid_stylePaintingId:${String(v).slice(0, 40)}`,
      );
    }
    out.push(v);
  }
  return out;
}

/** Parse + validate `blendTileIds` for `mode: 'style_blend'`.
 * Returns string[] of length [2, MAX_BLEND_TILES], or null when absent.
 * Distinct rules from `parseStylePaintingIds`:
 *   - Minimum 2 entries (1 is degenerate → use style_explore).
 *   - Maximum is MAX_BLEND_TILES (currently 4) — Pro's reasoning at
 *     N>4 reference inputs is unexplored territory and likely muddy.
 *   - DUPLICATES REJECTED — blend is "fuse N distinct references";
 *     a duplicate is a no-op user error, surface as 400 not silent dedup.
 *     This is the opposite policy from `parseStylePaintingIds`, where
 *     duplicates are the documented mechanism for "More like this".
 */
function parseBlendTileIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error("blendTileIds_must_be_array");
  if (raw.length < 2) {
    throw new Error("blendTileIds_need_min_2");
  }
  if (raw.length > MAX_BLEND_TILES) {
    throw new Error(`blendTileIds_too_many:max_${MAX_BLEND_TILES}`);
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.length === 0 || v.length > 64) {
      throw new Error(
        `invalid_blendStylePaintingId:${String(v).slice(0, 40)}`,
      );
    }
    out.push(v);
  }
  if (new Set(out).size !== out.length) {
    throw new Error("blendTileIds_must_be_unique");
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: {
    requestId?: unknown;
    sourceId?: unknown;
    modelTier?: unknown;
    resolution?: unknown;
    aspectRatioMode?: unknown;
    count?: unknown;
    presets?: unknown;
    mode?: unknown;
    stylePaintingIds?: unknown;
    /** v2.4: single style id for the prompt-mode handoff path. Distinct
     *  from `stylePaintingIds` (which is the per-tile array for
     *  style_explore mode). One field per mode = cleanest cross-field
     *  validation: each is allowed only in its mode, never both. */
    stylePaintingId?: unknown;
    /** v3.0: array of style_painting ids for the style_blend mode —
     *  pure multi-style fusion. Length [2, MAX_BLEND_TILES]. Distinct
     *  from `stylePaintingIds` (which is per-tile, allows duplicates).
     *  Duplicates here are REJECTED because blend = N distinct
     *  references. */
    blendTileIds?: unknown;
    parentTileId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : null;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;
  const modelTier =
    body.modelTier === "flash" || body.modelTier === "pro"
      ? body.modelTier
      : "pro";
  const resolution =
    body.resolution === "1k" || body.resolution === "4k"
      ? body.resolution
      : "1k";
  // Default to 'match' on missing/invalid input — preserves the historical
  // AGENTS.md §3 "output aspect == input aspect" invariant for any client
  // that doesn't know about the new field. 'flip' is opt-in via the
  // InputBar's Aspect toggle.
  const aspectRatioMode =
    body.aspectRatioMode === "flip" ? "flip" : "match";
  // mode default 'prompt' preserves v1 behavior for clients that don't
  // know about the new field (missing mode → 'prompt'). But an
  // explicitly-present unknown value (e.g. typo 'style_blanded') gets
  // rejected with a clear 400 instead of silently coercing to 'prompt'
  // — the prior silent-coerce path produced a misleading cascade where
  // the user got an "X requires mode=Y" error mentioning the mode they
  // thought they sent. Use the body's presence (vs missing) to
  // distinguish defaults from typos.
  let mode: "prompt" | "style_explore" | "style_blend";
  if (body.mode === undefined || body.mode === null) {
    mode = "prompt";
  } else if (
    body.mode === "prompt" ||
    body.mode === "style_explore" ||
    body.mode === "style_blend"
  ) {
    mode = body.mode;
  } else {
    return NextResponse.json(
      {
        error: "invalid_mode",
        detail: `mode must be one of: prompt, style_explore, style_blend (got ${JSON.stringify(body.mode).slice(0, 60)})`,
      },
      { status: 400 },
    );
  }
  const parentTileId =
    typeof body.parentTileId === "string" && body.parentTileId.length > 0
      ? body.parentTileId
      : null;
  // v2.4: single style painting id for prompt-mode handoff. Validate
  // tightly — same constraints as stylePaintingIds entries (ulid-ish
  // length cap; existence check below).
  const stylePaintingId =
    typeof body.stylePaintingId === "string" &&
    body.stylePaintingId.length > 0 &&
    body.stylePaintingId.length <= 64
      ? body.stylePaintingId
      : null;
  if (
    body.stylePaintingId !== undefined &&
    body.stylePaintingId !== null &&
    stylePaintingId === null
  ) {
    return NextResponse.json(
      {
        error: "invalid_stylePaintingId",
        detail: "stylePaintingId must be a non-empty string ≤ 64 chars",
      },
      { status: 400 },
    );
  }

  if (!requestId)
    return NextResponse.json({ error: "missing_requestId" }, { status: 400 });
  if (!sourceId)
    return NextResponse.json({ error: "missing_sourceId" }, { status: 400 });

  let count: number;
  let presets: Preset[];
  let stylePaintingIds: string[] | null;
  let blendTileIds: string[] | null;
  try {
    count = parseCount(body.count);
    presets = parsePresets(body.presets);
    stylePaintingIds = parseStylePaintingIds(body.stylePaintingIds);
    blendTileIds = parseBlendTileIds(body.blendTileIds);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid_input" },
      { status: 400 },
    );
  }

  // Mode-specific cross-field validation.
  if (mode === "style_explore") {
    if (!stylePaintingIds) {
      return NextResponse.json(
        {
          error: "missing_stylePaintingIds",
          detail: "mode='style_explore' requires stylePaintingIds[]",
        },
        { status: 400 },
      );
    }
    if (stylePaintingId !== null) {
      return NextResponse.json(
        {
          error: "stylePaintingId_requires_prompt_mode",
          detail:
            "stylePaintingId (single) is only valid when mode='prompt'. For style_explore, pass the per-tile array stylePaintingIds[] instead.",
        },
        { status: 400 },
      );
    }
    if (blendTileIds) {
      return NextResponse.json(
        {
          error: "blendTileIds_requires_style_blend_mode",
          detail:
            "blendTileIds is only valid when mode='style_blend'.",
        },
        { status: 400 },
      );
    }
    // The array length is authoritative — overrides any `count` the
    // client also sent. This way the worker's tilesFor() count and the
    // route's tile materialization always agree.
    count = stylePaintingIds.length;
  } else if (mode === "style_blend") {
    // v3.0 Style Blend — pure multi-style fusion. The route requires
    // blendTileIds (2..MAX_BLEND_TILES, no dupes) + rejects
    // every other style/prompt field. count comes from the body (NOT
    // from the array length — blend's array is the INPUTS, count is
    // how many output tiles the user wants).
    if (!blendTileIds) {
      return NextResponse.json(
        {
          error: "missing_blendTileIds",
          detail: "mode='style_blend' requires blendTileIds[]",
        },
        { status: 400 },
      );
    }
    if (stylePaintingIds) {
      return NextResponse.json(
        {
          error: "stylePaintingIds_requires_style_explore_mode",
          detail:
            "stylePaintingIds is only valid when mode='style_explore'.",
        },
        { status: 400 },
      );
    }
    if (stylePaintingId !== null) {
      return NextResponse.json(
        {
          error: "stylePaintingId_requires_prompt_mode",
          detail:
            "stylePaintingId is only valid when mode='prompt'.",
        },
        { status: 400 },
      );
    }
    if (parentTileId !== null) {
      return NextResponse.json(
        {
          error: "parentTileId_requires_prompt_mode",
          detail:
            "parentTileId provenance is only valid when mode='prompt'. Blend iterations are curatorial; they have no single parent tile.",
        },
        { status: 400 },
      );
    }
  } else {
    // prompt mode: stylePaintingIds (the array) is rejected — clients
    // should use the single stylePaintingId field instead. Same for
    // blendTileIds.
    if (stylePaintingIds) {
      return NextResponse.json(
        {
          error: "stylePaintingIds_requires_style_explore_mode",
          detail:
            "stylePaintingIds is only valid when mode='style_explore'. For prompt mode use the single stylePaintingId field.",
        },
        { status: 400 },
      );
    }
    if (blendTileIds) {
      return NextResponse.json(
        {
          error: "blendTileIds_requires_style_blend_mode",
          detail:
            "blendTileIds is only valid when mode='style_blend'.",
        },
        { status: 400 },
      );
    }
  }

  // Check ordering rationale: cheap checks first, expensive last.
  //   1. Idempotency       — fast-exit on retry
  //   2. Source existence  — 1 DB read; required by every mode
  //   3. Cap check         — 1 DB read (usage sum); reject capped users
  //                          before they pay for style-id existence reads
  //   4. Style id existence — N DB reads (up to 4 for blend); validates
  //                          FK targets that the schema can't enforce
  //                          (parent_tile_id + blend JSON aren't real FKs)
  //   5. Insert
  //
  // Earlier versions of this route did the style-id existence checks
  // BEFORE the cap check. A capped user pays N+1 DB reads to learn they
  // can't generate — wasteful and confusing if the response is "you're
  // capped" while the route just spent time validating ids that never
  // get used.

  // Idempotency: if a row already exists for this request_id, return it.
  const existing = findIterationByRequestId(requestId);
  if (existing) {
    return NextResponse.json(
      {
        iterationId: existing.id,
        idempotentReplay: true,
        count: existing.tile_count,
        presets: parseStoredPresets(existing.presets, existing.id),
        // Echo the original row's aspect_ratio_mode so the client's
        // optimistic skeleton uses the right effective aspect ratio when
        // the retry body differed (e.g., user toggled Match/Flip between
        // attempts). Worker keys off this column too — both sides have to
        // agree or thumbs render in the wrong container shape.
        aspectRatioMode: existing.aspect_ratio_mode,
        // Echo mode + parentTileId so the client can hydrate the right
        // optimistic placeholder shape — style_explore placeholders need
        // the StyleAttributionThumb slot; prompt-from-tile iterations
        // carry the parent_tile_id provenance link that the lightbox UI
        // surfaces. Per-tile style_painting_id is NOT echoed (lives on
        // the tiles rows; client refetches via /api/iterations to
        // hydrate the per-tile attribution on a fresh tab).
        mode: existing.mode,
        parentTileId: existing.parent_tile_id,
        // v3.0: echo blend style ids for style_blend iterations. JSON
        // parse here so the client gets a string[] not a stringified
        // JSON array. Empty array for non-blend modes (client ignores).
        // `existing.id` context is passed so any corrupted JSON in the
        // DB row surfaces as a warn-log with the iteration id (matches
        // the parseStoredPresets pattern above).
        blendTileIds: parseBlendTileIdsJson(
          existing.blend_tile_ids,
          existing.id,
        ),
      },
      { status: 200 },
    );
  }

  // Source must exist before we record an iteration.
  const source = getSource(sourceId);
  if (!source) {
    return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  }

  // Cap check: project the worst-case cost for this iteration and refuse if it
  // would push monthly usage over the cap.
  const projected = costFor(modelTier, resolution, count);
  const monthSoFar = monthlyUsageUsd();
  if (monthSoFar + projected > MONTHLY_USD_CAP) {
    return NextResponse.json(
      {
        error: "monthly_cap_reached",
        currentUsd: monthSoFar,
        projectedUsd: projected,
        capUsd: MONTHLY_USD_CAP,
      },
      { status: 429 },
    );
  }

  // Style-id existence checks. These run AFTER the cap check so capped
  // users don't pay N DB reads. The FK targets aren't enforced by
  // SQLite (parent_tile_id added via ALTER → no SET NULL enforcement;
  // blend_tile_ids is JSON not a real FK), so we check at the route
  // layer — otherwise a typo'd id dangles on every tile of the
  // iteration and surfaces as worker R2 fetch failures.

  // v2.4: single stylePaintingId for the prompt-mode handoff.
  if (stylePaintingId !== null) {
    const sp = getStylePainting(stylePaintingId);
    if (!sp) {
      return NextResponse.json(
        {
          error: "style_painting_not_found",
          detail: `no style_painting with id ${stylePaintingId}`,
        },
        { status: 404 },
      );
    }
  }

  // v3.4: validate every blendTileId references an existing, active
  // tile whose iteration is on the SAME source as this new iteration
  // (same-source rule per the v3.4 product spec). Pre-flight 404/400
  // keeps the user-visible failure clean — vs the worker discovering
  // missing rows mid-flight.
  //
  // Three constraints per tile id, mirroring the parentTileId checks:
  //   1. Tile row exists.
  //   2. Tile is ACTIVE (not soft-deleted) — otherwise the blend would
  //      use bytes for a tile that's been pruned from every UI surface.
  //   3. Tile's iteration belongs to the same `sourceId` we're
  //      iterating against. Cross-source blends are rejected — the
  //      UI gates this client-side too (selection only available on
  //      current source's stream) but defense-in-depth here protects
  //      against a hand-crafted POST.
  if (blendTileIds) {
    for (const tid of blendTileIds) {
      const inputTile = getTile(tid);
      if (!inputTile || inputTile.deleted_at !== null) {
        return NextResponse.json(
          {
            error: "blend_tile_not_found",
            detail: `no active tile with id ${tid}`,
          },
          { status: 404 },
        );
      }
      // v3.5: reject inputs that aren't 'done' (and therefore don't
      // have output_image_key bytes for the worker to fetch). The UI
      // gates this client-side (only 'done' tiles selectable in blend
      // mode) but defense-in-depth: a hand-crafted POST or a race
      // between selection + tile-status-change would otherwise sail
      // past the route + hard-fail at worker time, which is a worse
      // UX than a clean 400 here.
      if (
        inputTile.status !== "done" ||
        inputTile.output_image_key === null
      ) {
        return NextResponse.json(
          {
            error: "blend_tile_not_ready",
            detail: `blend tile ${tid} is not yet a completed tile (status=${inputTile.status})`,
          },
          { status: 400 },
        );
      }
      const inputIter = getIteration(inputTile.iteration_id);
      if (!inputIter || inputIter.source_id !== sourceId) {
        return NextResponse.json(
          {
            error: "blend_tile_cross_source",
            detail: `blend tile ${tid} belongs to a different source — same-source rule violated`,
          },
          { status: 400 },
        );
      }
    }
  }

  // v2.4: parentTileId existence + soft-delete + cross-source check.
  // Three constraints, all checked here:
  //   1. The tile row exists.
  //   2. The tile is ACTIVE (not soft-deleted) — otherwise the
  //      provenance link points at a tile every UI surface filters
  //      out. The lightbox breadcrumb would dereference to nothing.
  //   3. The parent tile's iteration lives on the same `sourceId` we're
  //      iterating against. The "Iterate on this direction" handoff UI
  //      always fires intra-source (the spawned iteration uses the
  //      current source); cross-source provenance creates a graph the
  //      UI can't render coherently.
  if (parentTileId !== null) {
    const parent = getTile(parentTileId);
    if (!parent || parent.deleted_at !== null) {
      return NextResponse.json(
        {
          error: "parent_tile_not_found",
          detail: `no active tile with id ${parentTileId}`,
        },
        { status: 404 },
      );
    }
    const parentIter = getIteration(parent.iteration_id);
    if (!parentIter || parentIter.source_id !== sourceId) {
      return NextResponse.json(
        {
          error: "parent_tile_cross_source",
          detail:
            "parentTileId must reference a tile whose iteration is on the same sourceId",
        },
        { status: 400 },
      );
    }
  }

  // Insert iteration + N pending tiles atomically. UNIQUE on request_id catches
  // concurrent dupes; on conflict, fall through to the existing-row branch.
  const iterationId = ulid();
  const now = Date.now();
  const presetsJson = JSON.stringify(presets);
  // v3.0: serialize the blend style ids array on style_blend iterations.
  // For every other mode, store the column's default value '[]' explicitly
  // so the worker's downstream JSON.parse can stay branch-free.
  const blendTileIdsJson =
    mode === "style_blend" && blendTileIds
      ? JSON.stringify(blendTileIds)
      : "[]";
  try {
    insertIterationAndTiles(
      {
        id: iterationId,
        request_id: requestId,
        source_id: sourceId,
        model_tier: modelTier,
        resolution,
        aspect_ratio_mode: aspectRatioMode,
        tile_count: count,
        presets: presetsJson,
        mode,
        parent_tile_id: parentTileId,
        blend_tile_ids: blendTileIdsJson,
        status: "pending",
        created_at: now,
        completed_at: null,
      },
      Array.from({ length: count }, (_, idx) => ({
        id: ulid(),
        iteration_id: iterationId,
        idx,
        output_image_key: null,
        thumb_image_key: null,
        status: "pending" as const,
        error_message: null,
        is_favorite: 0,
        favorited_at: null,
        // Per-tile style attribution.
        // - style_explore mode: index-aligned with stylePaintingIds so
        //   tile.idx i is generated against stylePaintingIds[i].
        // - prompt mode + stylePaintingId set: every tile carries the
        //   same single id (v2.4 "Iterate on this direction" handoff).
        //   The worker then pulls the style painting as second image
        //   input on every tile AND tells buildPrompt to prepend the
        //   style-reference sentence.
        // - prompt mode without stylePaintingId: NULL (the v1 default).
        style_painting_id:
          mode === "style_explore" && stylePaintingIds
            ? stylePaintingIds[idx]
            : stylePaintingId, // null in the no-handoff prompt-mode case
        created_at: now,
        completed_at: null,
      })),
    );
  } catch (e) {
    // UNIQUE collision on request_id — race winner created the row first.
    const reread = findIterationByRequestId(requestId);
    if (reread) {
      return NextResponse.json(
        {
          iterationId: reread.id,
          idempotentReplay: true,
          count: reread.tile_count,
          presets: parseStoredPresets(reread.presets, reread.id),
          // Same reconciliation rationale as the early-return branch
          // above — see that comment. Both replay paths must echo the
          // SAME field set or the client's reconcile is conditional on
          // which branch fired.
          aspectRatioMode: reread.aspect_ratio_mode,
          mode: reread.mode,
          parentTileId: reread.parent_tile_id,
          // v3.0 blend echo — must mirror the early-return branch above.
          // Asymmetric replay shapes (one branch echoes, the other
          // doesn't) were flagged by reviewer; the comment above
          // ("Both replay paths must echo the SAME field set") was
          // load-bearing — this catch branch was missing it.
          // Same context-arg rationale as the early-return branch
          // above — corruption warn-logs reference the iteration id.
          blendTileIds: parseBlendTileIdsJson(
            reread.blend_tile_ids,
            reread.id,
          ),
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        error: "insert_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  // Fire-and-forget. Errors logged but never surfaced as a 500 here — the SSE
  // stream is the canonical surface for per-tile failures.
  runIteration(iterationId).catch((err) => {
    console.error(`[runIteration ${iterationId}] unhandled:`, err);
  });

  return NextResponse.json({ iterationId }, { status: 200 });
}
