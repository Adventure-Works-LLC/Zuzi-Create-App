/**
 * Stuck-iteration recovery.
 *
 * When Railway redeploys mid-generation, in-flight workers die. The
 * iteration's row stays in `pending`/`running` status; its tile rows
 * stay in `pending` status forever; the SSE stream that would have
 * emitted `done` events is gone. The frontend renders the loading
 * animation indefinitely.
 *
 * Recovery flow per stuck iteration:
 *
 *   1. List the iteration's active (non-soft-deleted) tiles.
 *   2. For each `pending` tile, HEAD R2 for its expected output and
 *      thumb keys (`outputs/<iter>/<idx>.jpg`, `thumbs/<iter>/<idx>.webp`).
 *   3. Reconcile per-tile:
 *        - both keys present → status='done', populate the keys.
 *        - either missing    → status='failed', error_message='server_restart_recovered'.
 *      Already-`done`/`failed`/`blocked` tiles are skipped (the worker
 *      had already updated them before crashing — common on a partial
 *      mid-flight death).
 *   4. Roll the iteration status forward: `done` if any tile ended up
 *      `done`, otherwise `failed`. (We use 'failed' for a fully-empty
 *      iteration so the user sees a terminal state and can delete.)
 *   5. Persist the per-tile updates + iteration status update inside a
 *      single transaction so a partial failure rolls back cleanly.
 *
 * The whole sweep runs at boot via `instrumentation.ts`. Individual
 * iterations can also be re-recovered on-demand via
 * `POST /api/iterations/:id/recover` — useful if a tile reconnect
 * raced an R2 propagation or a HEAD failed transiently at boot.
 *
 * Why HEAD vs. the existing `recovery.jsonl` log: the worker writes
 * recovery.jsonl AFTER putObject + BEFORE updateTile, so the file is
 * a strict subset of "tiles whose bytes are in R2." HEAD is a strict
 * superset (any object that ever made it to R2). Using HEAD as the
 * source of truth handles the case where recovery.jsonl was lost
 * (manual /data nuke, volume mount glitch) and the case where the
 * worker died between putObject and the appendRecovery call.
 *
 * Native module note: this file imports `@aws-sdk/client-s3` via
 * lib/storage/r2 and `better-sqlite3` via lib/db. Any caller (route,
 * proxy, or instrumentation) MUST declare `runtime = 'nodejs'`.
 */

import { db } from "./db/client";
import {
  getIteration,
  listStuckIterations,
  tilesFor,
  updateIterationStatus,
  updateTile,
} from "./db/queries";
import { headObject } from "./storage/r2";
import type { Tile } from "./db/schema";

export type RecoveryOutcome =
  /** Every still-pending tile reconnected from R2; iteration is now `done`. */
  | "reconnected"
  /** Some tiles reconnected, some didn't; iteration is `done` with
   *  partial output. */
  | "partial"
  /** No tile bytes found in R2; iteration is `failed`. User sees a
   *  terminal state and can delete. */
  | "failed_no_tiles"
  /** Iteration disappeared between listing and processing, OR was
   *  already in a terminal state when we got to it. No-op. */
  | "skipped";

export interface RecoveryResult {
  iterationId: string;
  outcome: RecoveryOutcome;
  reconnectedTiles: number;
  failedTiles: number;
  /** Final iteration status. Useful for the on-demand recovery API
   *  response so the client can update its store directly. */
  iterationStatus: "pending" | "running" | "done" | "failed";
}

/**
 * Boot sweep: recover every iteration in `pending`/`running` status.
 * Returns one RecoveryResult per iteration so the caller (boot
 * instrumentation, `/api/iterations/:id/recover`) can log outcomes.
 *
 * Iterations are processed serially. R2 HEADs are parallel within an
 * iteration. At Zuzi's scale (tens of stuck iterations × few tiles
 * each) this finishes in a few seconds; we accept the latency to
 * keep recovery deterministic and easy to read in logs.
 */
export async function recoverStuckIterations(): Promise<RecoveryResult[]> {
  const stuck = listStuckIterations();
  const results: RecoveryResult[] = [];
  for (const iter of stuck) {
    results.push(await recoverOneIteration(iter.id));
  }
  return results;
}

/**
 * Recover a single iteration on demand. Idempotent — calling on an
 * already-terminal iteration returns `skipped` without touching the
 * DB. Used by both the boot sweep (one call per stuck iteration) and
 * `/api/iterations/:id/recover` (one call from the user's
 * "Try to recover" button).
 */
export async function recoverOneIteration(
  iterationId: string,
): Promise<RecoveryResult> {
  const iter = getIteration(iterationId);
  if (!iter) {
    return makeSkipped(iterationId, "pending");
  }
  if (iter.status !== "pending" && iter.status !== "running") {
    return makeSkipped(iterationId, iter.status);
  }
  const activeTiles = tilesFor(iterationId);

  // Process every tile in parallel: pending tiles get a 2-key R2 HEAD;
  // tiles already in a terminal state pass through unchanged.
  const tilePlans = await Promise.all(
    activeTiles.map(async (t): Promise<TilePlan> => {
      if (t.status !== "pending") {
        return {
          idx: t.idx,
          action: "skip",
          existingStatus: t.status,
        };
      }
      const outKey = `outputs/${iterationId}/${t.idx}.jpg`;
      const thumbKey = `thumbs/${iterationId}/${t.idx}.webp`;
      const [outExists, thumbExists] = await Promise.all([
        safeHead(outKey),
        safeHead(thumbKey),
      ]);
      if (outExists && thumbExists) {
        return { idx: t.idx, action: "reconnect", outputKey: outKey, thumbKey };
      }
      return { idx: t.idx, action: "fail" };
    }),
  );

  // Apply the plan in a single transaction.
  const now = Date.now();
  let reconnectedCount = 0;
  let failedCount = 0;
  db().transaction(() => {
    for (const plan of tilePlans) {
      if (plan.action === "reconnect") {
        updateTile(iterationId, plan.idx, {
          status: "done",
          output_image_key: plan.outputKey,
          thumb_image_key: plan.thumbKey,
          completed_at: now,
        });
        reconnectedCount++;
      } else if (plan.action === "fail") {
        updateTile(iterationId, plan.idx, {
          status: "failed",
          error_message: "server_restart_recovered",
          completed_at: now,
        });
        failedCount++;
      }
      // skip: already terminal, no-op
    }
    // Iteration status: 'done' if any tile is in a 'done' state — either
    // reconnected here or already-done before the worker crashed.
    // 'failed' if no tile ended up done. Never leave the iteration in
    // pending/running after recovery — the user must always reach a
    // terminal state.
    const anyDone = tilePlans.some(
      (p) =>
        p.action === "reconnect" ||
        (p.action === "skip" && p.existingStatus === "done"),
    );
    updateIterationStatus(iterationId, anyDone ? "done" : "failed", now);
  });

  // Outcome shape for logs / API response.
  const totalActionable = tilePlans.filter((p) => p.action !== "skip").length;
  let outcome: RecoveryOutcome;
  if (reconnectedCount === 0) {
    outcome = "failed_no_tiles";
  } else if (reconnectedCount === totalActionable) {
    outcome = "reconnected";
  } else {
    outcome = "partial";
  }

  return {
    iterationId,
    outcome,
    reconnectedTiles: reconnectedCount,
    failedTiles: failedCount,
    iterationStatus:
      reconnectedCount > 0 ||
      tilePlans.some(
        (p) => p.action === "skip" && p.existingStatus === "done",
      )
        ? "done"
        : "failed",
  };
}

function makeSkipped(
  iterationId: string,
  status: "pending" | "running" | "done" | "failed",
): RecoveryResult {
  return {
    iterationId,
    outcome: "skipped",
    reconnectedTiles: 0,
    failedTiles: 0,
    iterationStatus: status,
  };
}

async function safeHead(key: string): Promise<boolean> {
  try {
    return await headObject(key);
  } catch (e) {
    // Auth / network errors are not 404 — log loudly so we know the
    // recovery sweep is running blind, but treat the tile as missing
    // so it gets marked failed (better than leaving it pending).
    console.warn(
      `[stuckRecovery] HEAD ${key} failed, treating as missing:`,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

interface TilePlan {
  idx: number;
  action: "reconnect" | "fail" | "skip";
  outputKey?: string;
  thumbKey?: string;
  existingStatus?: Tile["status"];
}
