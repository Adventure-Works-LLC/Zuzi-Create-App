"use client";

/**
 * useStreamingResults — open an SSE EventSource per pending iteration in the
 * canvas store and wire its events into the store via updateTile.
 *
 * Why per-iteration: the API surface is `/api/iterate/[id]/stream` so each
 * iteration has its own URL. Multiple ESes can run in parallel — uncommon in
 * practice (the user typically generates one iteration at a time) but the
 * code shouldn't fall apart if it happens.
 *
 * Lifecycle (per iteration):
 *   1. When a pending iteration appears in the store, open EventSource for it.
 *   2. On 'tile' events → updateTile.
 *   3. On 'done' event → setIterationStatus done, close ES, then refetch
 *      `/api/iterations` for the current source so the canonical tile IDs
 *      land (we need them for the favorite endpoint). The refetch is scoped
 *      to limit=10 to keep payload small; that's larger than any single
 *      run but small enough to be cheap.
 *   4. On error / disconnect → reconnect via the browser's built-in retry.
 *      EventSource handles `retry: 3000` from the server hint.
 *
 * iPad sleep: when the iPad sleeps mid-run, EventSource pauses; on resume,
 * the browser reconnects (Safari does this on visibilitychange). The server
 * replays pending state on connect (subscribe-first → DB query → dedupe), so
 * no events are lost.
 *
 * Single global hook — call once at the page level.
 */

import { useEffect, useRef } from "react";

import {
  useCanvas,
  type Iteration,
  type IterationStatus,
  type TileStatus,
} from "@/stores/canvas";

interface TileEvent {
  idx: number;
  status: TileStatus;
  outputKey?: string;
  thumbKey?: string;
  error?: string;
}

export function useStreamingResults(): void {
  const iterations = useCanvas((s) => s.iterations);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const updateTile = useCanvas((s) => s.updateTile);
  const setIterationStatus = useCanvas((s) => s.setIterationStatus);
  const setIterations = useCanvas((s) => s.setIterations);

  // Track which iteration ids we've already attached an EventSource for.
  const attachedRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const attached = attachedRef.current;
    const wantedIds = new Set(
      iterations
        .filter(
          (it): it is Iteration =>
            (it.status === "pending" || it.status === "running") &&
            // Only iterations with a real (non-optimistic) id can stream — the
            // optimistic id is replaced once the POST returns.
            !it.id.startsWith("opt-"),
        )
        .map((it) => it.id),
    );

    // Open ES for newly-pending iterations.
    for (const iterationId of wantedIds) {
      if (attached.has(iterationId)) continue;
      const es = new EventSource(
        `/api/iterate/${encodeURIComponent(iterationId)}/stream`,
      );
      attached.set(iterationId, es);

      es.addEventListener("tile", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as TileEvent;
          updateTile(iterationId, data.idx, {
            status: data.status,
            outputKey: data.outputKey ?? null,
            thumbKey: data.thumbKey ?? null,
            errorMessage: data.error ?? null,
          });
        } catch (e) {
          console.warn("[sse tile] parse failed", e);
        }
      });

      es.addEventListener("done", () => {
        // Iteration complete — promote status, close ES, and refetch from
        // the canonical endpoint so we pick up the real tile.id values
        // (needed for the favorite endpoint). Only refetch if this iteration
        // belongs to the currently-displayed source.
        const finalStatus: IterationStatus = "done";
        setIterationStatus(iterationId, finalStatus);
        es.close();
        attached.delete(iterationId);

        const sourceForRefetch = currentSourceId;
        if (sourceForRefetch) {
          void (async () => {
            try {
              const resp = await fetch(
                `/api/iterations?sourceId=${encodeURIComponent(sourceForRefetch)}&limit=50`,
              );
              if (!resp.ok) return;
              const data = (await resp.json()) as {
                iterations: Array<{
                  id: string;
                  sourceId: string;
                  modelTier: "flash" | "pro";
                  resolution: "1k" | "4k";
                  tileCount: number;
                  presets: ("color" | "composition" | "lighting" | "background")[];
                  status: IterationStatus;
                  createdAt: number;
                  tiles: Array<{
                    id: string;
                    idx: number;
                    status: TileStatus;
                    outputKey: string | null;
                    thumbKey: string | null;
                    errorMessage: string | null;
                    isFavorite: boolean;
                    favoritedAt: number | null;
                  }>;
                }>;
              };
              setIterations(
                data.iterations.map((it) => ({
                  id: it.id,
                  sourceId: it.sourceId,
                  modelTier: it.modelTier,
                  resolution: it.resolution,
                  tileCount: it.tileCount,
                  presets: it.presets,
                  status: it.status,
                  createdAt: it.createdAt,
                  tiles: it.tiles.map((t) => ({
                    id: t.id,
                    iterationId: it.id,
                    idx: t.idx,
                    status: t.status,
                    outputKey: t.outputKey,
                    thumbKey: t.thumbKey,
                    errorMessage: t.errorMessage,
                    isFavorite: t.isFavorite,
                    favoritedAt: t.favoritedAt,
                  })),
                })),
              );
            } catch {
              /* swallow — UI still has SSE-derived state */
            }
          })();
        }
      });

      es.addEventListener("error", () => {
        // EventSource will auto-retry. If it CLOSED (readyState 2), give up.
        if (es.readyState === EventSource.CLOSED) {
          attached.delete(iterationId);
        }
      });
    }

    // Close ESes for iterations no longer in the wanted set (e.g. user
    // switched source mid-run; we'll re-attach if they switch back).
    for (const [id, es] of attached) {
      if (!wantedIds.has(id)) {
        es.close();
        attached.delete(id);
      }
    }
  }, [iterations, currentSourceId, updateTile, setIterationStatus, setIterations]);

  // Cleanup on unmount.
  useEffect(() => {
    const attached = attachedRef.current;
    return () => {
      for (const es of attached.values()) es.close();
      attached.clear();
    };
  }, []);
}
