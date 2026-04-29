"use client";

/**
 * Lightbox — full-bleed dark single-image view.
 *
 * Toolbar (bottom of the viewport):
 *   - Use as Source (uploads the rendered tile back as a new source row,
 *     making it the current source for the next generate)
 *   - Share (Web Share API → save to camera roll / AirDrop / Messages)
 *   - Favorite (heart toggle)
 *   - Close
 *
 * The lightbox subscribes to the open tile's id from the canvas store. Tap
 * outside the image (the dark surround) closes. Esc also closes.
 *
 * "Use as Source" is the quiet path back to the input bar: when Zuzi finds a
 * tile that's the right direction, she taps "Use as Source" and the next
 * generate runs against THAT tile. The flow re-uploads the tile bytes via
 * /api/sources so the new source has its own row + id (no implicit
 * "tile-as-source" coupling in the schema).
 */

import { useEffect, useState } from "react";
import { Loader2, Star, Share2, X, ArrowUpFromLine } from "lucide-react";

import { useCanvas } from "@/stores/canvas";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useFavorites } from "@/hooks/useFavorites";
import { useShare } from "@/hooks/useShare";
import { useSources } from "@/hooks/useSources";

export function Lightbox() {
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const setLightboxTile = useCanvas((s) => s.setLightboxTile);
  const iterations = useCanvas((s) => s.iterations);

  // Find the tile across iterations (the lightbox can be opened from any
  // iteration in the current source's stream).
  const tile = (() => {
    for (const it of iterations) {
      const t = it.tiles.find((x) => x.id === lightboxTileId);
      if (t) return { iter: it, tile: t };
    }
    return null;
  })();

  const fullKey = tile?.tile.outputKey ?? null;
  const { url } = useImageUrl(fullKey);
  const { toggle } = useFavorites();
  const { canShare, shareImage } = useShare();
  const { uploadFile } = useSources();
  const [busyAction, setBusyAction] = useState<"share" | "use" | null>(null);

  // Esc-to-close.
  useEffect(() => {
    if (!lightboxTileId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxTile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxTileId, setLightboxTile]);

  if (!lightboxTileId || !tile) return null;

  const onShare = async () => {
    if (!url) return;
    setBusyAction("share");
    try {
      await shareImage({
        url,
        filename: `zuzi-${tile.iter.id}-${tile.tile.idx + 1}.jpg`,
        title: "Zuzi Studio",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const onUseAsSource = async () => {
    if (!url) return;
    setBusyAction("use");
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("fetch failed");
      const blob = await resp.blob();
      const file = new File(
        [blob],
        `zuzi-${tile.iter.id}-${tile.tile.idx + 1}.jpg`,
        { type: blob.type || "image/jpeg" },
      );
      await uploadFile(file);
      setLightboxTile(null);
    } catch (e) {
      console.warn("[lightbox] use-as-source failed", e);
    } finally {
      setBusyAction(null);
    }
  };

  const onFavorite = () => {
    if (tile.tile.id.startsWith("opt-")) return;
    void toggle(tile.tile.id, !tile.tile.isFavorite);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={(e) => {
        // Click outside the inner image / toolbar closes.
        if (e.target === e.currentTarget) setLightboxTile(null);
      }}
    >
      {/* Image area */}
      <div
        className="flex flex-1 items-center justify-center p-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) setLightboxTile(null);
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="max-h-full max-w-full rounded-md"
          />
        ) : (
          <Loader2 className="h-8 w-8 text-text-mute animate-spin" />
        )}
      </div>

      {/* Toolbar */}
      <div
        className="flex items-center justify-center gap-2 px-4 py-4"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <button
          type="button"
          onClick={onUseAsSource}
          disabled={!url || busyAction !== null}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 no-callout"
        >
          {busyAction === "use" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUpFromLine className="h-4 w-4" strokeWidth={1.5} />
          )}
          Use as source
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => void onShare()}
            disabled={!url || busyAction !== null}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 no-callout"
          >
            {busyAction === "share" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" strokeWidth={1.5} />
            )}
            Share
          </button>
        )}
        <button
          type="button"
          onClick={onFavorite}
          disabled={tile.tile.id.startsWith("opt-")}
          className={[
            "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors no-callout",
            tile.tile.isFavorite
              ? "border-[#C9A878]/50 bg-[#C9A878]/15 text-[#E0BE8C]"
              : "border-white/20 bg-white/5 text-white hover:bg-white/10",
            "disabled:opacity-50",
          ].join(" ")}
          aria-pressed={tile.tile.isFavorite}
        >
          <Star
            className={[
              "h-4 w-4",
              tile.tile.isFavorite ? "fill-current" : "fill-none",
            ].join(" ")}
            strokeWidth={1.75}
          />
          {tile.tile.isFavorite ? "Favorited" : "Favorite"}
        </button>
        <button
          type="button"
          onClick={() => setLightboxTile(null)}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors no-callout"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
          Close
        </button>
      </div>
    </div>
  );
}
