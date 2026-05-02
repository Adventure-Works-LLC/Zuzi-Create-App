"use client";

/**
 * FavoritesPanel — slide-in drawer from the right showing favorited tiles
 * across ALL sources (active + archived), sorted favorited_at DESC.
 *
 * Per the plan, this is the persistent surface Zuzi returns to between
 * sessions. v1: a grid of thumbnails, tap → opens the lightbox.
 *
 * Lazy fetches /api/favorites on open; refetches each time the drawer opens
 * so newly-favorited items show up. (No live store mirror — keeping the
 * drawer's lifecycle simple is worth the extra fetch per open.)
 *
 * Compare-2-up is a v1 nice-to-have layered on top of this; for now the panel
 * just makes the cross-source favorites visible.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas, type AspectRatioMode } from "@/stores/canvas";
import { flipAspectRatio } from "@/lib/gemini/aspectRatio";

interface FavoriteRow {
  tileId: string;
  sourceId: string;
  sourceArchived: boolean;
  sourceAspectRatio: string;
  /** R2 key for the original painting that produced this tile. Threaded
   *  through to the LightboxSnapshot so Compare-with-Original mode can
   *  render the source alongside the generated tile without an extra
   *  /api/sources roundtrip. */
  sourceInputKey: string;
  /** Iteration's aspect-ratio mode at generation time. Combine with
   *  `sourceAspectRatio` to get the tile's effective aspect for display
   *  (`mode === 'flip' ? flip(src) : src`). Optional in the response
   *  shape so older clients viewing old data don't crash; the default
   *  is 'match' which preserves prior behavior. */
  aspectRatioMode?: AspectRatioMode;
  iterationId: string;
  idx: number;
  outputKey: string | null;
  thumbKey: string | null;
  favoritedAt: number;
  modelTier: "flash" | "pro";
  resolution: "1k" | "4k";
}

/** Effective aspect ratio for a favorite — flips if the iteration was
 *  generated under flip mode. Centralised here so both the thumbnail
 *  container and the LightboxSnapshot construction agree on the value. */
function effectiveAspectRatio(fav: FavoriteRow): string {
  return fav.aspectRatioMode === "flip"
    ? flipAspectRatio(fav.sourceAspectRatio)
    : fav.sourceAspectRatio;
}

function FavoriteThumb({ favorite }: { favorite: FavoriteRow }) {
  const { url } = useImageUrl(favorite.thumbKey);
  // Mirror the OUTPUT aspect ratio on the container. Under 'match' mode
  // that's the source aspect (preserves the historical AGENTS.md §3
  // invariant); under 'flip' it's the mirrored aspect. Either way, the
  // thumbnail container matches the actual tile dimensions so it doesn't
  // center-crop to square.
  const aspect = effectiveAspectRatio(favorite);
  // Memoize the inline style so a fresh object literal isn't created on
  // every render — avoids spurious diffs when the panel re-renders during
  // open/close transitions or while scrolling the favorites grid.
  const aspectStyle = useMemo(
    () => ({ aspectRatio: aspect.replace(":", "/") }),
    [aspect],
  );
  return (
    <div
      style={aspectStyle}
      className="relative w-full overflow-hidden rounded-md ring-1 ring-hairline/60"
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bloom-warm" aria-hidden />
      )}
      {favorite.sourceArchived && (
        <span className="absolute bottom-1 right-1 rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-mute">
          archived
        </span>
      )}
    </div>
  );
}

export function FavoritesPanel() {
  const open = useCanvas((s) => s.favoritesOpen);
  const setOpen = useCanvas((s) => s.setFavoritesOpen);
  const setLightboxSnapshot = useCanvas((s) => s.setLightboxSnapshot);
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);

  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch("/api/favorites?limit=100", {
          signal: ac.signal,
        });
        if (!resp.ok) throw new Error(`favorites fetch failed (${resp.status})`);
        const data = (await resp.json()) as { favorites: FavoriteRow[] };
        setFavorites(data.favorites);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [open]);

  // Esc-to-close.
  // Lightbox (z-50) sits on top of FavoritesPanel (z-40); both attach
  // window-level keydown listeners, so peel topmost first — if a lightbox
  // is open (either by-id or snapshot mode), let its handler consume the
  // Esc and skip closing the panel. Second Esc then closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Favorites"
      className="fixed inset-0 z-40 flex"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="flex-1 bg-black/40" />
      <aside
        className={[
          "h-dvh w-full max-w-[520px] shrink-0",
          "bg-background border-l border-hairline",
          "flex flex-col",
        ].join(" ")}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          <h2 className="font-display text-2xl tracking-tight text-foreground">
            Favorites
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-2 text-text-mute hover:text-foreground hover:bg-secondary transition-colors no-callout"
            aria-label="Close favorites"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {loading && (
            <div className="flex items-center justify-center py-20 text-text-mute">
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
            </div>
          )}
          {error && !loading && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && favorites.length === 0 && (
            <p className="caption-display text-sm text-text-mute italic">
              No favorites yet — tap a tile&rsquo;s star to keep it.
            </p>
          )}
          {!loading && favorites.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {favorites.map((fav) => (
                <button
                  key={fav.tileId}
                  type="button"
                  onClick={() => {
                    // Open the cross-source lightbox in snapshot mode.
                    // The favorite may belong to an archived source whose
                    // iterations[] was never loaded into the canvas store, so
                    // we hand the Lightbox the full tile shape directly
                    // instead of asking it to walk iterations[] (which would
                    // miss). The panel stays mounted behind (z-40 vs Lightbox
                    // z-50) so closing the lightbox returns the user to the
                    // grid they were browsing.
                    setLightboxSnapshot({
                      tileId: fav.tileId,
                      iterationId: fav.iterationId,
                      // idx is needed downstream for unique share /
                      // use-as-source filenames (zuzi-<iter>-<idx+1>.jpg);
                      // two favorites from the same iteration would otherwise
                      // share a filename and overwrite on iPad Files.
                      idx: fav.idx,
                      outputKey: fav.outputKey,
                      thumbKey: fav.thumbKey,
                      // Anything in this list is favorited by definition.
                      isFavorite: true,
                      favoritedAt: fav.favoritedAt,
                      sourceAspectRatio: fav.sourceAspectRatio,
                      // Original painting's R2 key — needed by the
                      // Lightbox's Compare-with-Original mode. Server-side
                      // join populates this for every favorite, including
                      // those from archived sources whose iterations[]
                      // never loaded into the canvas store.
                      sourceInputKey: fav.sourceInputKey,
                      // Thread the iteration's aspect-mode through to the
                      // lightbox snapshot so the snapshot path knows whether
                      // the tile was flipped — relevant for any future
                      // display logic that needs the effective tile aspect.
                      aspectRatioMode: fav.aspectRatioMode ?? "match",
                      modelTier: fav.modelTier,
                      resolution: fav.resolution,
                    });
                  }}
                  className="block focus:outline-none focus:ring-2 focus:ring-accent rounded-md no-callout"
                  aria-label="Open favorite"
                >
                  <FavoriteThumb favorite={fav} />
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
