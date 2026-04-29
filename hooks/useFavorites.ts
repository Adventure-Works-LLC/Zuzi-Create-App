"use client";

/**
 * useFavorites — toggle favorite on a tile (optimistic).
 *
 * The Favorites PANEL (cross-source list) is fetched lazily by FavoritesPanel
 * itself — that's a once-on-open fetch and not worth holding in zustand for
 * the whole session. This hook is purely about the toggle button.
 *
 * Optimism: flip the store immediately, POST, roll back on failure.
 */

import { useCallback } from "react";

import { useCanvas } from "@/stores/canvas";

export interface UseFavoritesResult {
  toggle: (tileId: string, next: boolean) => Promise<void>;
}

export function useFavorites(): UseFavoritesResult {
  const setTileFavorite = useCanvas((s) => s.setTileFavorite);

  const toggle = useCallback(
    async (tileId: string, next: boolean) => {
      const now = Date.now();
      // Optimistic.
      setTileFavorite(tileId, next, next ? now : null);
      try {
        const resp = await fetch("/api/favorite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tileId, value: next }),
        });
        if (!resp.ok) throw new Error(`favorite failed (${resp.status})`);
        const data = (await resp.json()) as {
          tileId: string;
          isFavorite: boolean;
          favoritedAt: number | null;
        };
        // Reconcile with server truth.
        setTileFavorite(data.tileId, data.isFavorite, data.favoritedAt);
      } catch (e) {
        // Rollback.
        setTileFavorite(tileId, !next, !next ? now : null);
        throw e;
      }
    },
    [setTileFavorite],
  );

  return { toggle };
}
