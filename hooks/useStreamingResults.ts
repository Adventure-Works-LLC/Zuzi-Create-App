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
 * iPad sleep — visibilitychange forced reconnect: when iOS Safari backgrounds
 * a tab (lock screen, app switch, PWA suspend), the underlying socket can
 * silently die without the EventSource ever firing `error`. Result: the ES
 * sits in OPEN state forever holding a dead connection. We force a reconnect
 * on visibilitychange → 'visible' by closing every attached EventSource and
 * letting the next render re-open them via the wantedIds/attached path
 * below. The server's subscribe-first → DB-replay path handles state
 * catch-up, so no events are lost across the reconnect.
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

  // visibilitychange-forced reconnect. iOS Safari can leave EventSource in
  // OPEN state with a dead socket after the tab is backgrounded; the only
  // reliable fix is to close + reopen on the way back to visible. The
  // server-side subscribe-first → DB-replay branch catches state up, so
  // anything we missed while sleeping is replayed on the new connection.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      const attached = attachedRef.current;
      // Close every ES and clear the attached map, then re-open inline
      // for currently-pending iterations using the latest store
      // snapshot. We do the reopen INLINE rather than nudging the
      // reconcile effect via state because iterations is often
      // referentially stable mid-run — a re-render isn't guaranteed,
      // and we don't want a dropped tab to wait for the next SSE event
      // (which may never arrive on the dead connection) before noticing.
      for (const es of attached.values()) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
      attached.clear();
      const current = useCanvas.getState().iterations;
      const wantedIds = current
        .filter(
          (it) =>
            (it.status === "pending" || it.status === "running") &&
            !it.id.startsWith("opt-"),
        )
        .map((it) => it.id);

      for (const iterationId of wantedIds) {
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
          setIterationStatus(iterationId, "done");
          es.close();
          attached.delete(iterationId);
        });

        es.addEventListener("error", () => {
          if (es.readyState === EventSource.CLOSED) {
            attached.delete(iterationId);
          }
        });
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [updateTile, setIterationStatus]);

  // Cleanup on unmount.
  useEffect(() => {
    const attached = attachedRef.current;
    return () => {
      for (const es of attached.values()) es.close();
      attached.clear();
    };
  }, []);
}
