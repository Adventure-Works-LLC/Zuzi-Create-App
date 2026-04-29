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

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas } from "@/stores/canvas";

interface FavoriteRow {
  tileId: string;
  sourceId: string;
  sourceArchived: boolean;
  iterationId: string;
  outputKey: string | null;
  thumbKey: string | null;
  favoritedAt: number;
  modelTier: "flash" | "pro";
  resolution: "1k" | "4k";
}

function FavoriteThumb({ favorite }: { favorite: FavoriteRow }) {
  const { url } = useImageUrl(favorite.thumbKey);
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-md ring-1 ring-hairline/60">
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

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
      <div className="flex-1 bg-black/40 backdrop-blur-sm" />
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
                    // Closes the panel; the tile stream / lightbox don't
                    // currently subscribe to cross-source favorites for opening
                    // tiles — clicking just dismisses for now. A v2 polish
                    // pass can wire a "preview this favorite" path, but per
                    // the plan the cross-source open lives in
                    // CompareLightbox.
                    setOpen(false);
                  }}
                  className="block focus:outline-none focus:ring-2 focus:ring-accent rounded-md no-callout"
                  aria-label="Favorite tile"
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
