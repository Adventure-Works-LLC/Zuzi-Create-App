"use client";

/**
 * StyleAttributionThumb — small attribution chip rendered BELOW a
 * style_explore result tile. Renders a 36×36 square thumbnail of the
 * source style painting + a one-line title caption.
 *
 * Why under, not over: Zuzi's no-overlay constraint (the same one that
 * drove the Tile action-row redesign — see Tile.tsx docstring header).
 * The painting surface stays untouched; attribution sits in its own
 * vertical slot so the result tile reads as the painting.
 *
 * Lookup: takes a stylePaintingId, finds the row in the canvas store's
 * stylePaintings[] (already hydrated by useStylePaintings on Studio
 * mount). If the row isn't found (style painting was hard-deleted
 * between the tile's iteration and now), renders a small "Style
 * unavailable" placeholder — the tile + R2 output persist after the
 * style FK nulls per migration 0006's enforcement model, so the
 * attribution surface needs a graceful missing-row case.
 */

import { useMemo } from "react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas } from "@/stores/canvas";

export interface StyleAttributionThumbProps {
  /** The style_paintings.id this tile was generated against. NULL for
   *  prompt-mode tiles — caller should gate on this and not render. */
  stylePaintingId: string;
  /** Optional size override in px. Default 36 — readable but unobtrusive,
   *  fits under a 218–358px tile without dominating. */
  size?: number;
}

export function StyleAttributionThumb({
  stylePaintingId,
  size = 36,
}: StyleAttributionThumbProps) {
  // Memoize the lookup. Library hydrates once on mount; the selector
  // re-runs on every store update but the lookup is O(n) per render.
  // Keep this cheap — typical library is ≤100 paintings.
  const stylePainting = useCanvas((s) =>
    s.stylePaintings.find((sp) => sp.id === stylePaintingId),
  );

  const captionText = useMemo(() => {
    if (!stylePainting) return "Style unavailable";
    if (stylePainting.title) return stylePainting.title;
    if (stylePainting.originalFilename) {
      // Strip extension for cleaner caption when no explicit title.
      return stylePainting.originalFilename.replace(/\.[^.]+$/, "");
    }
    return "Untitled style";
  }, [stylePainting]);

  // useImageUrl tolerates null/empty keys — returns { url: null }. So
  // the missing-row case renders the placeholder block without an
  // errant /api/image-url fetch.
  const { url } = useImageUrl(stylePainting?.inputKey ?? null);

  const sizeStyle = useMemo(
    () => ({ width: size, height: size }),
    [size],
  );

  return (
    <div className="flex items-center gap-2 px-0.5 py-1">
      <div
        style={sizeStyle}
        className={[
          "relative shrink-0 overflow-hidden rounded-sm",
          "ring-1 ring-hairline/50",
          !stylePainting && "bg-secondary",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden
      >
        {stylePainting && url ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : stylePainting ? (
          // Style exists but the URL hasn't loaded yet — show the
          // bloom-warm shimmer (matches the empty-canvas + source-
          // thumbnail loading state across the rest of the app).
          <div className="absolute inset-0 bloom-warm" aria-hidden />
        ) : null}
      </div>
      <p
        className={[
          "caption-display truncate text-[11px]",
          stylePainting ? "text-text-mute" : "text-text-mute/60 italic",
        ].join(" ")}
        title={captionText}
      >
        Style: {captionText}
      </p>
    </div>
  );
}
