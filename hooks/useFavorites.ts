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
import { authFetch } from "@/lib/auth/authFetch";
import { TIMEOUT_JSON_MS, withTimeout } from "@/lib/fetchTimeout";

// v4.6: per-tile toggle sequence. A rapid double-toggle raced its own
// reconcile: POST #1's success response landed AFTER toggle #2's
// optimistic flip and reverted the heart to #1's state (and a rollback
// from a failed #1 could clobber #2 the same way). Each toggle takes a
// sequence number; reconciles/rollbacks apply only if theirs is still
// the newest for that tile.
const toggleSeqByTile = new Map<string, number>();

export interface UseFavoritesResult {
  toggle: (tileId: string, next: boolean) => Promise<void>;
}

export function useFavorites(): UseFavoritesResult {
  const setTileFavorite = useCanvas((s) => s.setTileFavorite);

  const toggle = useCallback(
    async (tileId: string, next: boolean) => {
      const now = Date.now();
      const seq = (toggleSeqByTile.get(tileId) ?? 0) + 1;
      toggleSeqByTile.set(tileId, seq);
      // Optimistic.
      setTileFavorite(tileId, next, next ? now : null);
      try {
        const resp = await authFetch(
          "/api/favorite",
          withTimeout(
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tileId, value: next }),
            },
            TIMEOUT_JSON_MS,
          ),
        );
        if (!resp.ok) throw new Error(`favorite failed (${resp.status})`);
        const data = (await resp.json()) as {
          tileId: string;
          isFavorite: boolean;
          favoritedAt: number | null;
        };
        // Reconcile with server truth — unless a newer toggle superseded us.
        if (toggleSeqByTile.get(tileId) !== seq) return;
        setTileFavorite(data.tileId, data.isFavorite, data.favoritedAt);
      } catch (e) {
        // Rollback — unless a newer toggle superseded us.
        if (toggleSeqByTile.get(tileId) === seq) {
          setTileFavorite(tileId, !next, !next ? now : null);
        }
        throw e;
      }
    },
    [setTileFavorite],
  );

  return { toggle };
}
