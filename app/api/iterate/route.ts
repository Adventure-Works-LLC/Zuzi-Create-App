/**
 * POST /api/iterate — kick off a 9-tile generation against a source.
 *
 * Body: {requestId, sourceId, modelTier?, resolution?}
 *   - requestId: client-supplied ulid for idempotency. Replays return the same
 *     iterationId.
 *   - sourceId: must reference an existing sources row.
 *   - modelTier: 'flash' | 'pro' (default 'pro' per AGENTS.md §4)
 *   - resolution: '1k' | '4k' (default '1k')
 *
 * Returns: { iterationId }
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
import { runIteration } from "@/lib/gemini/runIteration";
import { pricePerGrid } from "@/lib/cost";

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

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: {
    requestId?: unknown;
    sourceId?: unknown;
    modelTier?: unknown;
    resolution?: unknown;
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

  // Idempotency: if a row already exists for this request_id, return it.
  const existing = findIterationByRequestId(requestId);
  if (existing) {
    return NextResponse.json(
      { iterationId: existing.id, idempotentReplay: true },
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
  const projected = pricePerGrid(modelTier, resolution);
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

  // Insert iteration + 9 pending tiles atomically. UNIQUE on request_id catches
  // concurrent dupes; on conflict, fall through to the existing-row branch.
  const iterationId = ulid();
  const now = Date.now();
  try {
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
  } catch (e) {
    // UNIQUE collision on request_id — race winner created the row first.
    const reread = findIterationByRequestId(requestId);
    if (reread) {
      return NextResponse.json(
        { iterationId: reread.id, idempotentReplay: true },
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
