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
  type Iteration,
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

export interface UseIterationsResult {
  loading: boolean;
  error: string | null;
  generating: boolean;
  generate: () => Promise<GenerateResult | null>;
}

export function useIterations(): UseIterationsResult {
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const setIterations = useCanvas((s) => s.setIterations);
  const prependIteration = useCanvas((s) => s.prependIteration);
  const setIterationStatus = useCanvas((s) => s.setIterationStatus);
  const modelTier = useCanvas((s) => s.modelTier);
  const resolution = useCanvas((s) => s.resolution);
  const presets = useCanvas((s) => s.presets);
  const count = useCanvas((s) => s.count);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Refetch when currentSourceId changes.
  useEffect(() => {
    abortRef.current?.abort();
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

    try {
      const resp = await fetch("/api/iterate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          sourceId: currentSourceId,
          modelTier,
          resolution,
          count,
          presets,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        iterationId?: string;
        idempotentReplay?: boolean;
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

      // Swap optimistic id → canonical id. Keep the tile placeholders so the
      // user keeps seeing them while the worker fires; SSE will then update
      // each tile's status / output keys as Gemini returns.
      useCanvas.getState().setIterations(
        useCanvas.getState().iterations.map((it) =>
          it.id === optimisticId
            ? {
                ...it,
                id: iterationId,
                tiles: it.tiles.map((t) => ({
                  ...t,
                  iterationId,
                  // We don't know the canonical tile.id from the route response
                  // — SSE doesn't ship them either, just (idx, status, keys).
                  // Use a deterministic placeholder so list reconciliation is
                  // stable. The favorite endpoint needs the real id; before
                  // the user can favorite, they need a successful tile, which
                  // means we'll have refreshed from /api/iterations anyway.
                  id: `${iterationId}-${t.idx}`,
                })),
              }
            : it,
        ),
      );
      return { iterationId, idempotentReplay: data.idempotentReplay };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Mark optimistic as failed so the user sees something — easier to
      // diagnose than silent disappearance. Component-level error UI can
      // pick this up.
      setIterationStatus(optimisticId, "failed");
      return null;
    } finally {
      setGenerating(false);
    }
  }, [
    currentSourceId,
    modelTier,
    resolution,
    presets,
    count,
    prependIteration,
    setIterationStatus,
  ]);

  return { loading, error, generating, generate };
}
