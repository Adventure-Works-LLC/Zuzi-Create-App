/**
 * POST /api/iterate — kick off an N-tile generation against a source.
 *
 * Body: {requestId, sourceId, modelTier?, resolution?, count?, presets?}
 *   - requestId: client-supplied ulid for idempotency. Replays return the same
 *     iterationId.
 *   - sourceId: must reference an existing sources row.
 *   - modelTier: 'flash' | 'pro' (default 'pro' per AGENTS.md §4)
 *   - resolution: '1k' | '4k' (default '1k')
 *   - count: integer in [1, TILE_COUNT_MAX]; default TILE_COUNT_DEFAULT.
 *     Number of tiles to generate. Persisted on `iterations.tile_count`.
 *   - presets: array of preset strings, subset of PRESETS (color, composition,
 *     lighting, background). Default []. Persisted as JSON on
 *     `iterations.presets`. Determines the prompt via
 *     `lib/gemini/imagePrompts.ts buildPrompt()`.
 *
 * Returns:
 *   - First write: { iterationId }
 *   - Idempotent replay (early short-circuit OR UNIQUE collision):
 *       { iterationId, idempotentReplay: true, count, presets }
 *     where `count` and `presets` reflect the ORIGINAL row's values, NOT the
 *     retry's body. The client reconciles its optimistic placeholder skeleton
 *     against these fields in `hooks/useIterations.ts` so a retry whose body
 *     differed renders the right number of tiles and the right preset chips.
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

import { getSession } from "@/lib/auth/session";
import {
  findIterationByRequestId,
  getSource,
  insertIterationAndTiles,
  monthlyUsageUsd,
} from "@/lib/db/queries";
import { PRESETS, type Preset } from "@/lib/db/schema";
import { runIteration } from "@/lib/gemini/runIteration";
import {
  TILE_COUNT_DEFAULT,
  TILE_COUNT_MAX,
} from "@/lib/gemini/imagePrompts";
import { parseStoredPresets } from "@/lib/gemini/presets";
import { costFor } from "@/lib/cost";

export const runtime = "nodejs";

const MONTHLY_USD_CAP = Number(process.env.MONTHLY_USD_CAP ?? "80");

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

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

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: {
    requestId?: unknown;
    sourceId?: unknown;
    modelTier?: unknown;
    resolution?: unknown;
    count?: unknown;
    presets?: unknown;
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

  if (!requestId)
    return NextResponse.json({ error: "missing_requestId" }, { status: 400 });
  if (!sourceId)
    return NextResponse.json({ error: "missing_sourceId" }, { status: 400 });

  let count: number;
  let presets: Preset[];
  try {
    count = parseCount(body.count);
    presets = parsePresets(body.presets);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid_input" },
      { status: 400 },
    );
  }

  // Idempotency: if a row already exists for this request_id, return it.
  const existing = findIterationByRequestId(requestId);
  if (existing) {
    return NextResponse.json(
      {
        iterationId: existing.id,
        idempotentReplay: true,
        count: existing.tile_count,
        presets: parseStoredPresets(existing.presets, existing.id),
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

  // Insert iteration + N pending tiles atomically. UNIQUE on request_id catches
  // concurrent dupes; on conflict, fall through to the existing-row branch.
  const iterationId = ulid();
  const now = Date.now();
  const presetsJson = JSON.stringify(presets);
  try {
    insertIterationAndTiles(
      {
        id: iterationId,
        request_id: requestId,
        source_id: sourceId,
        model_tier: modelTier,
        resolution,
        tile_count: count,
        presets: presetsJson,
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
