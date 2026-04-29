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
 *   2. On 'tile' events → updateTile (the event now carries the canonical
 *      tile.id, so the synthetic placeholder is replaced as tiles complete —
 *      no post-done refetch needed).
 *   3. On 'done' event → setIterationStatus done, close ES.
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
  type TileStatus,
} from "@/stores/canvas";

interface TileEvent {
  /** Canonical tiles.id (ulid) — the SSE/bus payload now carries this so the
   * client can replace the synthetic `${iterationId}-${idx}` placeholder with
   * the real DB id. The favorite endpoint requires the real id. */
  id: string;
  idx: number;
  status: TileStatus;
  outputKey?: string;
  thumbKey?: string;
  error?: string;
}

export function useStreamingResults(): void {
  const iterations = useCanvas((s) => s.iterations);
  const updateTile = useCanvas((s) => s.updateTile);
  const setIterationStatus = useCanvas((s) => s.setIterationStatus);

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
            id: data.id,
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
        // Iteration complete — promote status, close ES. No refetch: the
        // canonical tile ids are already in the store via the `tile` events
        // above. Cost is recorded server-side via usage_log in the worker
        // (see lib/gemini/runIteration.ts).
        setIterationStatus(iterationId, "done");
        es.close();
        attached.delete(iterationId);
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
  }, [iterations, updateTile, setIterationStatus]);

  // Cleanup on unmount.
  useEffect(() => {
    const attached = attachedRef.current;
    return () => {
      for (const es of attached.values()) es.close();
      attached.clear();
    };
  }, []);
}
