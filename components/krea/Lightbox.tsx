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

/** Flat view used by the rendering layer regardless of how the lightbox was
 *  opened. `byId` mode (Tile.tsx → walk iterations[]) and `snapshot` mode
 *  (FavoritesPanel.tsx → cross-source) both resolve to this shape. */
interface LightboxView {
  tileId: string;
  iterationId: string;
  idx: number;
  outputKey: string | null;
  isFavorite: boolean;
}

export function Lightbox() {
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);
  const setLightboxTile = useCanvas((s) => s.setLightboxTile);
  const setLightboxSnapshot = useCanvas((s) => s.setLightboxSnapshot);
  const iterations = useCanvas((s) => s.iterations);

  const isOpen = lightboxTileId !== null || lightboxSnapshot !== null;

  // Resolve the open target into a flat view.
  //
  // Prefer the snapshot when set: FavoritesPanel uses it for cross-source
  // tiles (the favorited tile may be from an archived source whose
  // iterations[] was never loaded into the store; walking iterations[] would
  // return null and the lightbox would render empty).
  //
  // Fall back to the iterations[] walk for the by-id path used by Tile.tsx
  // taps within the current source's stream. That path supports live
  // updates — when a tile state changes (favorite toggled, SSE event), the
  // selector re-runs and the lightbox re-renders against fresh state.
  const view: LightboxView | null = (() => {
    if (lightboxSnapshot) {
      return {
        tileId: lightboxSnapshot.tileId,
        iterationId: lightboxSnapshot.iterationId,
        idx: lightboxSnapshot.idx,
        outputKey: lightboxSnapshot.outputKey,
        isFavorite: lightboxSnapshot.isFavorite,
      };
    }
    if (lightboxTileId !== null) {
      for (const it of iterations) {
        const t = it.tiles.find((x) => x.id === lightboxTileId);
        if (t) {
          return {
            tileId: t.id,
            iterationId: it.id,
            idx: t.idx,
            outputKey: t.outputKey,
            isFavorite: t.isFavorite,
          };
        }
      }
    }
    return null;
  })();

  const fullKey = view?.outputKey ?? null;
  const { url } = useImageUrl(fullKey);
  const { toggle } = useFavorites();
  const { canShare, shareImage } = useShare();
  const { promoteFromTile } = useSources();
  const [busyAction, setBusyAction] = useState<"share" | "use" | null>(null);
  /** Visible error string for whichever action just failed. Cleared on the
   *  next attempt or close. Replaces the prior swallowed-to-console.warn
   *  pattern that hid Use-as-Source breakage entirely. */
  const [actionError, setActionError] = useState<string | null>(null);

  /** Close clears both state slots and any inline error. Either mode can
   *  have been the opener. */
  const closeLightbox = () => {
    setLightboxTile(null);
    setLightboxSnapshot(null);
    setActionError(null);
  };

  // Esc-to-close.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeLightbox is stable per-render; Esc handler doesn't depend on view content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!view) return null;

  const onShare = async () => {
    if (!url) return;
    setBusyAction("share");
    try {
      await shareImage({
        url,
        filename: `zuzi-${view.iterationId}-${view.idx + 1}.jpg`,
        title: "Zuzi Studio",
      });
    } finally {
      setBusyAction(null);
    }
  };

  /**
   * "Use as Source" — promote the open tile into a new source row.
   *
   * Was previously a client roundtrip: fetch the cached signed URL → blob
   * → File → multipart POST /api/sources. That had two failure modes,
   * both swallowed silently to console.warn:
   *   1. Cached signed URL expires after 1h. If the lightbox had been
   *      open >1h, the fetch step 403'd. The user clicked the button, the
   *      console.warn fired, but the user saw nothing change.
   *   2. Blob → File → multipart added a re-encode roundtrip that wasn't
   *      doing anything useful — the worker had already written a clean
   *      JPEG to R2.
   *
   * v2 (this code): single JSON POST to /api/sources with the tileId.
   * Server reads the bytes from R2 directly, runs the same sharp normalize
   * as a multipart upload, returns the new source. Plus user-visible
   * errors (replaces the console.warn blackhole) and step-by-step
   * console.info breadcrumbs so any future failure is easy to localize
   * from production logs.
   */
  const onUseAsSource = async () => {
    if (!view) return;
    if (view.tileId.startsWith("opt-")) {
      setActionError(
        "Optimistic tile not yet finalized — wait a moment and try again.",
      );
      return;
    }
    setBusyAction("use");
    setActionError(null);
    console.info(
      "[lightbox] use-as-source: clicked",
      { tileId: view.tileId, iterationId: view.iterationId },
    );
    try {
      console.info("[lightbox] use-as-source: POST /api/sources start");
      const newSource = await promoteFromTile(view.tileId);
      console.info(
        "[lightbox] use-as-source: POST /api/sources ok",
        { newSourceId: newSource.sourceId, inputKey: newSource.inputKey },
      );
      // useSources.promoteFromTile already calls the canvas store's
      // addSource, which both inserts the new source AND sets it as
      // currentSourceId (see stores/canvas.ts addSource). So we don't
      // need a separate setCurrentSource call here — the new source
      // is already current and the InputBar's Generate is wired up.
      console.info("[lightbox] use-as-source: closing lightbox");
      closeLightbox();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[lightbox] use-as-source: failed", { message, error: e });
      setActionError(`Couldn't use as source — ${message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const onFavorite = () => {
    if (view.tileId.startsWith("opt-")) return;
    void toggle(view.tileId, !view.isFavorite);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={(e) => {
        // Click outside the inner image / toolbar closes.
        if (e.target === e.currentTarget) closeLightbox();
      }}
    >
      {/* Image area.
          NOTE: `min-h-0` is load-bearing. Flex children default to
          `min-height: auto` which lets them grow past the parent's resolved
          height — when the source painting is taller than the dialog (e.g. a
          portrait painting on iPad in landscape), that pushes the toolbar
          below the visible viewport and the user can't reach Save / Use as
          source / Favorite / Close. With `min-h-0` the flex item respects its
          flex-basis so `max-h-full` on the <img> resolves against the bounded
          area and the toolbar stays anchored at the bottom. */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeLightbox();
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="max-h-full max-w-full rounded-md object-contain"
          />
        ) : (
          <Loader2 className="h-8 w-8 text-text-mute animate-spin" />
        )}
      </div>

      {/* Inline error banner — surfaces failures from Use-as-Source / Share
          that previously got swallowed to console.warn. `shrink-0` keeps it
          above the toolbar; quiet warm orange (`#C9602B`-ish) so it reads
          without screaming. Auto-clears on the next action attempt or close. */}
      {actionError && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 mx-4 mb-1 rounded-md bg-[#C9602B]/15 border border-[#C9602B]/40 px-4 py-2 text-sm text-[#E8B58A]"
        >
          {actionError}
        </div>
      )}

      {/* Toolbar — `shrink-0` keeps the buttons their natural size so the
          flex-1 image area can never push them past the viewport. The bottom
          padding adds env(safe-area-inset-bottom) so on iPad the row sits
          above the home-indicator gutter (~34px in standalone mode). */}
      <div
        className="flex shrink-0 items-center justify-center gap-2 px-4 py-4"
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
          disabled={view.tileId.startsWith("opt-")}
          className={[
            "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors no-callout",
            view.isFavorite
              ? "border-[#C9A878]/50 bg-[#C9A878]/15 text-[#E0BE8C]"
              : "border-white/20 bg-white/5 text-white hover:bg-white/10",
            "disabled:opacity-50",
          ].join(" ")}
          aria-pressed={view.isFavorite}
        >
          <Star
            className={[
              "h-4 w-4",
              view.isFavorite ? "fill-current" : "fill-none",
            ].join(" ")}
            strokeWidth={1.75}
          />
          {view.isFavorite ? "Favorited" : "Favorite"}
        </button>
        <button
          type="button"
          onClick={closeLightbox}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors no-callout"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
          Close
        </button>
      </div>
    </div>
  );
}
