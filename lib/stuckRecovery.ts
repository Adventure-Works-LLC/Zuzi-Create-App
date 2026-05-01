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
 *      The HEAD wrapper (`safeHead`) returns true / false / null:
 *        - true  → object confirmed present
 *        - false → R2 returned 404, object confirmed absent
 *        - null  → R2 returned a non-404 error (auth blip, transient
 *                  5xx, network timeout); we don't actually know
 *   3. Reconcile per-tile:
 *        - both keys present → status='done', populate the keys.
 *        - either confirmed 404 → status='failed',
 *                                 error_message='server_restart_recovered'.
 *        - either unknown (null) → DEFER the whole iteration this boot.
 *                                  No DB writes, iteration stays in
 *                                  pending. Next boot's sweep (or the
 *                                  user's manual `/recover` tap) will
 *                                  re-evaluate when R2 is reachable.
 *      Already-`done`/`failed`/`blocked` tiles are skipped (the worker
 *      had already updated them before crashing — common on a partial
 *      mid-flight death).
 *   4. Roll the iteration status forward: `done` if any tile ended up
 *      `done`, otherwise `failed`. (We use 'failed' for a fully-empty
 *      iteration so the user sees a terminal state and can delete.)
 *      DEFERRED iterations skip step 4 — the iteration row is left
 *      untouched and stays in pending status.
 *   5. Persist the per-tile updates + iteration status update inside a
 *      single transaction so a partial failure rolls back cleanly.
 *
 * The whole sweep runs at boot via `instrumentation.ts`. Individual
 * iterations can also be re-recovered on-demand via
 * `POST /api/iterations/:id/recover` — useful if a tile reconnect
 * raced an R2 propagation or a HEAD failed transiently at boot
 * (which now returns `outcome: "deferred"` instead of false-failing).
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
  | "skipped"
  /** R2 returned a non-404 error on at least one HEAD (auth blip,
   *  transient 5xx, network timeout, etc.). Recovery did NOT touch
   *  the DB — iteration stays pending so the next boot's sweep (or
   *  the user's manual `/recover` tap) can re-evaluate when R2 is
   *  reachable again. Without this distinction, a transient R2
   *  outage at boot would permanently mark every stuck tile failed
   *  even when the bytes actually exist. */
  | "deferred";

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
  // tiles already in a terminal state pass through unchanged. safeHead
  // returns true (object exists), false (R2 confirmed 404), or null
  // (R2 returned a non-404 error and we don't actually know either way).
  // The null case is the load-bearing distinction: if a single HEAD
  // can't tell us whether the bytes exist, we MUST NOT mark the tile
  // failed — a transient R2 outage at boot would otherwise silently
  // wipe out every still-pending tile across every stuck iteration.
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
      // Per-tile decision tree:
      //   - both true                → reconnect (worker had finished
      //                                  upload before crash)
      //   - both false (404)         → fail (worker died before any
      //                                  upload happened)
      //   - mixed false/false        → fail (one of the two keys is
      //                                  confirmed missing; we don't
      //                                  re-derive thumb from output
      //                                  in v1, so partial = fail)
      //   - either is null (unknown) → defer the whole iteration this
      //                                  boot (caller short-circuits)
      if (outExists === null || thumbExists === null) {
        return { idx: t.idx, action: "defer" };
      }
      if (outExists && thumbExists) {
        return { idx: t.idx, action: "reconnect", outputKey: outKey, thumbKey };
      }
      return { idx: t.idx, action: "fail" };
    }),
  );

  // Defer-the-whole-iteration check. If ANY pending tile's HEAD came
  // back unknown, leave every tile + the iteration row alone. The
  // user still sees the stuck UI; the next boot (or a manual
  // `/recover` tap) re-evaluates when R2 is reachable. Deferring at
  // the iteration level rather than the tile level keeps state
  // coherent — we never end up with a half-failed-half-pending row
  // whose subsequent recovery would have to special-case the partial
  // state.
  if (tilePlans.some((p) => p.action === "defer")) {
    return {
      iterationId,
      outcome: "deferred",
      reconnectedTiles: 0,
      failedTiles: 0,
      iterationStatus: iter.status,
    };
  }

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

/**
 * Three-state HEAD wrapper:
 *   - returns `true`  → R2 returned 200, object exists.
 *   - returns `false` → R2 returned 404, object confirmed missing.
 *   - returns `null`  → R2 returned a non-404 error (auth blip,
 *                        transient 5xx, network timeout). We don't
 *                        actually know whether the object exists.
 *
 * The null case is what makes the recovery sweep robust against a
 * transient R2 outage at boot. The previous version of this helper
 * coerced any non-404 error into `false` (treat as missing), which
 * meant a brief R2 hiccup during the boot HEAD storm would cascade
 * into every stuck tile being permanently marked failed even when
 * its bytes were sitting in R2 the whole time. Returning null and
 * letting the caller defer the whole iteration preserves the
 * recovery contract — eventually every iteration reconciles to a
 * terminal state OR is deleted by the user — without falsely
 * failing on an outage we'd otherwise have no chance to retry.
 */
async function safeHead(key: string): Promise<boolean | null> {
  try {
    return await headObject(key);
  } catch (e) {
    // Non-404 R2 error. Log with the reason so deferred iterations
    // are debuggable from Railway logs (we can correlate "iteration X
    // deferred" with "HEAD outputs/X/0.jpg got <reason>").
    console.warn(
      `[stuckRecovery] HEAD ${key} non-404 error, deferring iteration:`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

interface TilePlan {
  idx: number;
  /**
   * - reconnect : both R2 keys present → flip tile to `done`,
   *               populate output + thumb keys.
   * - fail      : at least one key 404 → flip tile to `failed`
   *               with `error_message='server_restart_recovered'`.
   * - skip      : tile already in a terminal status when we
   *               looked (rare worker race where DB write landed
   *               before crash).
   * - defer     : at least one HEAD returned non-404 error; we
   *               don't know enough to decide. Caller short-
   *               circuits the whole iteration — no DB writes,
   *               iteration stays pending, next boot tries again.
   */
  action: "reconnect" | "fail" | "skip" | "defer";
  outputKey?: string;
  thumbKey?: string;
  existingStatus?: Tile["status"];
}
