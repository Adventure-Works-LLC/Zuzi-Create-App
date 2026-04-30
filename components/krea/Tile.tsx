"use client";

/**
 * Tile — one generated tile in the stream.
 *
 * States the user can see:
 *   pending → soft warm pulse, no image (placeholder is the affordance)
 *   done    → image cross-fades in (4px blur → 0, 8px translate, 300ms ease-out)
 *   blocked → small ShieldOff icon + "skipped" caption (safety filter)
 *   failed  → small dot + error tooltip on long-press
 *
 * Interactions:
 *   tap       → opens lightbox
 *   star icon → toggles favorite (visible affordance, see UX_INSPIRATION.md)
 *
 * The thumbnail is fetched via useImageUrl with the tile's `thumbKey` (R2 key
 * for the 512px webp). The lightbox uses the full-resolution `outputKey`.
 */

import { useEffect, useState } from "react";
import { ShieldOff, Star } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useFavorites } from "@/hooks/useFavorites";
import { useCanvas, type Tile as TileT } from "@/stores/canvas";

interface TileProps {
  tile: TileT;
  /** Source aspect ratio in "W:H" form (e.g. "4:5", "16:9"). Output aspect ==
   * input aspect (AGENTS.md §3) so the tile container must mirror it; otherwise
   * `object-cover` center-crops the painting and obscures keep/discard cues. */
  aspectRatio: string;
  /** Optimistic ids (placed before /api/iterate replies) shouldn't allow
   * favoriting yet — there's no DB row to write against. */
  optimistic?: boolean;
}

export function Tile({ tile, aspectRatio, optimistic = false }: TileProps) {
  const setLightboxTile = useCanvas((s) => s.setLightboxTile);
  const { toggle } = useFavorites();
  const { url, loading } = useImageUrl(tile.thumbKey);
  const [imageReady, setImageReady] = useState(false);

  // Reset blur-fade when the URL or status changes.
  useEffect(() => {
    if (tile.status !== "done" || !url) {
      setImageReady(false);
    }
  }, [url, tile.status]);

  const onTap = () => {
    if (tile.status === "done") setLightboxTile(tile.id);
  };

  const onFav = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (optimistic || tile.id.startsWith("opt-")) return;
    // useFavorites does optimistic update + automatic rollback on failure,
    // so the user-visible feedback IS the star snapping back. That's the
    // intentional UX for a high-frequency action (toast spam would hurt).
    // Still: log the actual failure reason so any future debugging session
    // has a breadcrumb instead of pure silence. The prior `.catch(() => {})`
    // ate even the console signal.
    void toggle(tile.id, !tile.isFavorite).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[tile] favorite toggle failed (rolled back)", {
        tileId: tile.id,
        nextValue: !tile.isFavorite,
        message,
        error: err,
      });
    });
  };

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={tile.status !== "done"}
      style={{ aspectRatio: aspectRatio.replace(":", "/") }}
      className={[
        "group relative w-full overflow-hidden rounded-lg",
        "bg-card",
        tile.status === "done"
          ? "ring-1 ring-hairline/70 hover:ring-hairline cursor-zoom-in"
          : "ring-1 ring-hairline/40",
        "transition-all duration-200",
      ].join(" ")}
      aria-label={
        tile.status === "done"
          ? "Open tile"
          : tile.status === "blocked"
            ? "Tile blocked by safety filter"
            : tile.status === "failed"
              ? "Tile failed"
              : "Tile generating"
      }
    >
      {/* Soft warm pulse for pending tiles. The "bloom-warm" class lives in
          globals.css. */}
      {tile.status === "pending" && (
        <div
          className="absolute inset-0 bloom-warm animate-pulse"
          aria-hidden
        />
      )}

      {/* Done tile — image with blur-fade entrance. */}
      {tile.status === "done" && url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setImageReady(true)}
          className={[
            "absolute inset-0 h-full w-full object-cover",
            "transition-[opacity,filter,transform] duration-300 ease-out",
            imageReady
              ? "opacity-100 blur-0 translate-y-0"
              : "opacity-0 blur-[4px] translate-y-2",
          ].join(" ")}
        />
      )}

      {/* Loading shimmer fallback while we resolve the signed URL */}
      {tile.status === "done" && (loading || !url) && (
        <div className="absolute inset-0 bloom-warm opacity-50" aria-hidden />
      )}

      {/* Blocked / failed — quiet quasi-error state. Never red error blocks. */}
      {(tile.status === "blocked" || tile.status === "failed") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          {tile.status === "blocked" ? (
            <ShieldOff className="h-6 w-6 text-text-mute" strokeWidth={1.5} />
          ) : (
            <span
              className="block h-2 w-2 rounded-full bg-text-mute/60"
              aria-hidden
            />
          )}
          <span className="caption-display text-xs text-text-mute">
            {tile.status === "blocked" ? "skipped" : "couldn't render"}
          </span>
        </div>
      )}

      {/* Favorite star — top-right corner. Visible only when the tile is done.
          Slightly larger touch target than the icon to land on iPad finger. */}
      {tile.status === "done" && !optimistic && !tile.id.startsWith("opt-") && (
        <span
          onClick={onFav}
          role="button"
          tabIndex={0}
          aria-pressed={tile.isFavorite}
          aria-label={tile.isFavorite ? "Unfavorite" : "Favorite"}
          className={[
            "absolute top-2 right-2 z-10",
            "flex h-9 w-9 items-center justify-center rounded-full",
            "transition-colors",
            tile.isFavorite
              ? "bg-background/70 text-accent"
              : "bg-background/40 text-foreground/0 group-hover:text-foreground/70 hover:bg-background/70",
            // On touch devices (no hover), keep the star visible when active.
            "supports-[hover:none]:text-foreground/40",
          ].join(" ")}
        >
          <Star
            className={[
              "h-4 w-4",
              tile.isFavorite ? "fill-current" : "fill-none",
            ].join(" ")}
            strokeWidth={1.75}
          />
        </span>
      )}
    </button>
  );
}
