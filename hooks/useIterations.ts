"use client";

/**
 * useIterations — fetch the iteration history for the current source and
 * expose `generate()` to fire a new run.
 *
 * Mounting / source-switch behavior:
 *   - When `currentSourceId` changes, refetch /api/iterations?sourceId=X for
 *     that source and replace the store's iterations[].
 *   - If currentSourceId is null, clear iterations[] (the empty-state surface).
 *
 * Generate flow:
 *   1. Build a fresh request body using current store settings (modelTier,
 *      resolution, presets, count) + a new ulid as requestId (idempotency key).
 *   2. POST /api/iterate.
 *   3. Optimistically prepend a "pending" iteration to the store with N
 *      pending tile placeholders so the user sees the placeholders BEFORE the
 *      server replies — feels instant.
 *   4. When the response returns, swap the optimistic iteration's id with
 *      the canonical iterationId. The SSE hook (useStreamingResults) takes
 *      over from there.
 *   5. On error, remove the optimistic iteration and surface the message.
 *
 * Uses plain fetch + AbortController.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ulid } from "ulid";

import {
  useCanvas,
  type AspectRatioMode,
  type Iteration,
  type IterationStatus,
  type ModelTier,
  type Resolution,
  type Tile,
} from "@/stores/canvas";
import type { Preset } from "@/lib/db/schema";

interface IterationResponseRow {
  id: string;
  sourceId: string;
  modelTier: ModelTier;
  resolution: Resolution;
  aspectRatioMode: AspectRatioMode;
  tileCount: number;
  presets: Preset[];
  status: Iteration["status"];
  createdAt: number;
  completedAt: number | null;
  tiles: Array<{
    id: string;
    idx: number;
    status: Tile["status"];
    outputKey: string | null;
    thumbKey: string | null;
    errorMessage: string | null;
    isFavorite: boolean;
    favoritedAt: number | null;
    createdAt: number;
    completedAt: number | null;
  }>;
}

function rowToIteration(r: IterationResponseRow): Iteration {
  return {
    id: r.id,
    sourceId: r.sourceId,
    modelTier: r.modelTier,
    resolution: r.resolution,
    aspectRatioMode: r.aspectRatioMode ?? "match",
    tileCount: r.tileCount,
    presets: r.presets,
    status: r.status,
    createdAt: r.createdAt,
    tiles: r.tiles.map((t) => ({
      id: t.id,
      iterationId: r.id,
      idx: t.idx,
      status: t.status,
      outputKey: t.outputKey,
      thumbKey: t.thumbKey,
      errorMessage: t.errorMessage,
      isFavorite: t.isFavorite,
      favoritedAt: t.favoritedAt,
    })),
  };
}

export interface GenerateResult {
  iterationId: string;
  idempotentReplay?: boolean;
}

export interface RecoverIterationResult {
  iterationId: string;
  /**
   * - reconnected     : every still-pending tile reconnected from R2
   * - partial         : some reconnected, some confirmed missing
   * - failed_no_tiles : no R2 bytes anywhere; iteration is now `failed`
   * - skipped         : iteration was already in a terminal state
   * - deferred        : R2 returned a non-404 error on at least one
   *                     HEAD; recovery left the iteration in pending
   *                     so the next boot (or another manual tap) can
   *                     try again. The UI keeps the stuck banner
   *                     visible — wait or retry.
   */
  outcome: "reconnected" | "partial" | "failed_no_tiles" | "skipped" | "deferred";
  reconnectedTiles: number;
  failedTiles: number;
  iterationStatus: IterationStatus;
}

export interface UseIterationsResult {
  loading: boolean;
  error: string | null;
  generating: boolean;
  generate: () => Promise<GenerateResult | null>;
  /** Hard-delete an iteration via DELETE /api/iterations/:id. Optimistic
   *  store removal (drops iteration + closes lightbox if it was on
   *  one of the iteration's tiles) before the network roundtrip; on
   *  failure refetches the source's iterations to recover canonical
   *  state and rethrows. */
  deleteIteration: (iterationId: string) => Promise<void>;
  /** Manually trigger recovery for a stuck iteration via POST
   *  /api/iterations/:id/recover. Returns the recovery outcome so the
   *  caller can refetch + show feedback. The hook itself refetches the
   *  current source's iterations on a non-skipped outcome so the UI
   *  picks up the new tile + iteration statuses. */
  recoverIteration: (iterationId: string) => Promise<RecoverIterationResult>;
}

export function useIterations(): UseIterationsResult {
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const setIterations = useCanvas((s) => s.setIterations);
  const prependIteration = useCanvas((s) => s.prependIteration);
  const setIterationStatus = useCanvas((s) => s.setIterationStatus);
  const modelTier = useCanvas((s) => s.modelTier);
  const resolution = useCanvas((s) => s.resolution);
  const aspectRatioMode = useCanvas((s) => s.aspectRatioMode);
  const presets = useCanvas((s) => s.presets);
  const count = useCanvas((s) => s.count);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Separate controller for in-flight POST /api/iterate. Mid-flight source
  // switches must abort it so its response can't land on a stale source's
  // iterations[] (and orphan an iteration row in the swap loop). Generate is
  // disabled while `generating === true`, so this ref only ever holds 1.
  const generateAbortRef = useRef<AbortController | null>(null);

  // Refetch when currentSourceId changes.
  useEffect(() => {
    abortRef.current?.abort();
    // Source switch invalidates any in-flight generate — see comment on
    // generateAbortRef.
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    if (!currentSourceId) {
      setIterations([]);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch(
          `/api/iterations?sourceId=${encodeURIComponent(currentSourceId)}&limit=50`,
          { signal: ac.signal },
        );
        if (!resp.ok) throw new Error(`iterations fetch failed (${resp.status})`);
        const data = (await resp.json()) as { iterations: IterationResponseRow[] };
        setIterations(data.iterations.map(rowToIteration));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [currentSourceId, setIterations]);

  const generate = useCallback(async (): Promise<GenerateResult | null> => {
    if (!currentSourceId) {
      setError("no_source");
      return null;
    }
    setError(null);
    setGenerating(true);

    // Optimistic placeholder — gets swapped after the POST returns. The
    // optimistic id is unique per click so React keys don't collide.
    const optimisticId = `opt-${ulid()}`;
    const requestId = ulid();
    const now = Date.now();
    const optimistic: Iteration = {
      id: optimisticId,
      sourceId: currentSourceId,
      modelTier,
      resolution,
      aspectRatioMode,
      tileCount: count,
      presets,
      status: "pending",
      createdAt: now,
      tiles: Array.from({ length: count }, (_, idx) => ({
        id: `${optimisticId}-${idx}`,
        iterationId: optimisticId,
        idx,
        status: "pending" as const,
        outputKey: null,
        thumbKey: null,
        errorMessage: null,
        isFavorite: false,
        favoritedAt: null,
      })),
    };
    prependIteration(optimistic);

    // Abort any prior in-flight generate before issuing this one. Generate is
    // disabled while `generating === true`, so this is defensive — the source-
    // switch effect aborts here too.
    generateAbortRef.current?.abort();
    const ac = new AbortController();
    generateAbortRef.current = ac;

    try {
      const resp = await fetch("/api/iterate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          sourceId: currentSourceId,
          modelTier,
          resolution,
          aspectRatioMode,
          count,
          presets,
        }),
        signal: ac.signal,
      });
      const data = (await resp.json().catch(() => ({}))) as {
        iterationId?: string;
        idempotentReplay?: boolean;
        // On idempotent replay the server echoes the ORIGINAL row's values
        // (which may differ from this retry's body if the user changed
        // count/presets/aspectRatioMode between attempts). Client must
        // reconcile so the optimistic skeleton matches what the worker is
        // actually firing — wrong aspectRatioMode = thumbs rendering with
        // the wrong container shape (e.g., portrait skeleton on a flipped-
        // landscape iteration), since the worker keys off the persisted
        // aspect_ratio_mode regardless of body.
        count?: number;
        presets?: Preset[];
        aspectRatioMode?: AspectRatioMode;
        error?: string;
        detail?: string;
        currentUsd?: number;
        capUsd?: number;
      };
      if (!resp.ok) {
        // Remove the optimistic placeholder.
        useCanvas
          .getState()
          .setIterations(
            useCanvas.getState().iterations.filter((i) => i.id !== optimisticId),
          );
        if (resp.status === 429 && data.error === "monthly_cap_reached") {
          throw new Error(
            `Monthly cap reached: $${(data.currentUsd ?? 0).toFixed(2)} / $${(data.capUsd ?? 0).toFixed(0)}`,
          );
        }
        throw new Error(
          data.detail ?? data.error ?? `iterate failed (${resp.status})`,
        );
      }
      const iterationId = data.iterationId;
      if (!iterationId) throw new Error("no_iterationId_in_response");

      // Reconcile against echoed count/presets/aspectRatioMode. On a fresh
      // insert the server doesn't echo these (matches our request body). On
      // an idempotent replay they reflect the ORIGINAL row's values; if the
      // user's retry differed, we must rebuild the optimistic skeleton to
      // match the server's reality — otherwise the SSE stream emits the
      // wrong number of tile events for our skeleton (surplus placeholders
      // hang in pending forever) OR the IterationRow renders thumbs in the
      // wrong aspect-ratio container (because the row's effective aspect is
      // derived from `iteration.aspectRatioMode` and the worker is keying
      // off the persisted column, not our body).
      const canonicalCount =
        typeof data.count === "number" && data.count > 0 ? data.count : count;
      const canonicalPresets = Array.isArray(data.presets)
        ? (data.presets as Preset[])
        : presets;
      const canonicalAspectRatioMode: AspectRatioMode =
        data.aspectRatioMode === "match" || data.aspectRatioMode === "flip"
          ? data.aspectRatioMode
          : aspectRatioMode;

      // Swap optimistic id → canonical id, and resize the tile array if the
      // echoed count differs. SSE will replace each tile's synthetic id with
      // the real ulid as it arrives.
      useCanvas.getState().setIterations(
        useCanvas.getState().iterations.map((it) =>
          it.id === optimisticId
            ? {
                ...it,
                id: iterationId,
                tileCount: canonicalCount,
                presets: canonicalPresets,
                aspectRatioMode: canonicalAspectRatioMode,
                tiles: Array.from({ length: canonicalCount }, (_, idx) => {
                  const existing = it.tiles[idx];
                  return existing
                    ? {
                        ...existing,
                        iterationId,
                        // Synthetic placeholder — replaced by canonical id on
                        // each tile's SSE event. Tiles only become favoritable
                        // at status === 'done', by which point SSE has swapped
                        // the id in.
                        id: `${iterationId}-${idx}`,
                      }
                    : {
                        // Surplus tile when the server's count > our optimistic
                        // count. Build a fresh placeholder.
                        id: `${iterationId}-${idx}`,
                        iterationId,
                        idx,
                        status: "pending" as const,
                        outputKey: null,
                        thumbKey: null,
                        errorMessage: null,
                        isFavorite: false,
                        favoritedAt: null,
                      };
                }),
              }
            : it,
        ),
      );
      return { iterationId, idempotentReplay: data.idempotentReplay };
    } catch (e) {
      // AbortError = source-switched (or unmount); the placeholder is already
      // gone via the source-switch effect's setIterations([]) — don't surface
      // to the user.
      if ((e as Error).name === "AbortError") return null;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Mark optimistic as failed so the user sees something — easier to
      // diagnose than silent disappearance. Component-level error UI can
      // pick this up.
      setIterationStatus(optimisticId, "failed");
      return null;
    } finally {
      if (generateAbortRef.current === ac) generateAbortRef.current = null;
      setGenerating(false);
    }
  }, [
    currentSourceId,
    modelTier,
    resolution,
    aspectRatioMode,
    presets,
    count,
    prependIteration,
    setIterationStatus,
  ]);

  // Refetch helper used by deleteIteration's failure-rollback and
  // recoverIteration's success-refresh. We re-execute the source-switch
  // effect's fetch (without the loading state churn) so the canvas
  // store catches up to canonical server state. Bypasses the
  // currentSourceId guard via direct call.
  const refetchIterationsForCurrent = useCallback(async () => {
    const sid = useCanvas.getState().currentSourceId;
    if (!sid) return;
    try {
      const resp = await fetch(
        `/api/iterations?sourceId=${encodeURIComponent(sid)}&limit=50`,
      );
      if (!resp.ok) return;
      const data = (await resp.json()) as { iterations: IterationResponseRow[] };
      useCanvas.getState().setIterations(data.iterations.map(rowToIteration));
    } catch {
      // best-effort refresh; let the next user navigation reconcile
    }
  }, []);

  const deleteIteration = useCallback(
    async (iterationId: string): Promise<void> => {
      // Optimistic store removal — iteration leaves the stream
      // immediately. Lightbox closes if it was on one of this
      // iteration's tiles (handled in the store action).
      const before = useCanvas.getState().iterations;
      useCanvas.getState().removeIteration(iterationId);
      try {
        const resp = await fetch(
          `/api/iterations/${encodeURIComponent(iterationId)}`,
          { method: "DELETE" },
        );
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(
            data.detail ?? data.error ?? `delete failed (${resp.status})`,
          );
        }
      } catch (e) {
        // Rollback: restore the iterations we removed optimistically
        // and refetch canonical state.
        useCanvas.getState().setIterations(before);
        await refetchIterationsForCurrent();
        throw e;
      }
    },
    [refetchIterationsForCurrent],
  );

  const recoverIteration = useCallback(
    async (iterationId: string): Promise<RecoverIterationResult> => {
      const resp = await fetch(
        `/api/iterations/${encodeURIComponent(iterationId)}/recover`,
        { method: "POST" },
      );
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(
          data.detail ?? data.error ?? `recover failed (${resp.status})`,
        );
      }
      const result = (await resp.json()) as RecoverIterationResult;
      // Refetch the source's iterations only when the server actually
      // mutated state. `skipped` (iteration was already terminal) and
      // `deferred` (R2 erroring; recovery short-circuited without DB
      // writes) both leave the DB unchanged — refetching would be
      // pure noise. Other outcomes flip tile + iteration statuses
      // server-side, so the UI needs the fresh shape.
      if (result.outcome !== "skipped" && result.outcome !== "deferred") {
        await refetchIterationsForCurrent();
      }
      return result;
    },
    [refetchIterationsForCurrent],
  );

  return {
    loading,
    error,
    generating,
    generate,
    deleteIteration,
    recoverIteration,
  };
}
