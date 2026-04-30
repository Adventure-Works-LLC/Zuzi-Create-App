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
  // Use-as-Source from a snapshot lightbox (opened from FavoritesPanel)
  // creates a new source and switches the canvas to it. The FavoritesPanel
  // is its own state slot — it doesn't auto-close when the lightbox does —
  // so without an explicit dismiss the user lands on the new source's
  // empty stream with the favorites grid still overlaying everything.
  // We pull setFavoritesOpen here so the success path can close it.
  const setFavoritesOpen = useCanvas((s) => s.setFavoritesOpen);
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
  const { canShare } = useShare();
  const { promoteFromTile } = useSources();
  const [busyAction, setBusyAction] = useState<"share" | "use" | null>(null);
  /** Visible error string for whichever action just failed. Cleared on the
   *  next attempt or close. Replaces the prior swallowed-to-console.warn
   *  pattern that hid Use-as-Source breakage entirely. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Pre-fetched image bytes for the Share path. Loaded as soon as `url`
   *  resolves so that when the user clicks Share we can construct the File
   *  + call navigator.share() synchronously from the click event — which
   *  is what iOS Safari requires (any `await` between user gesture and
   *  navigator.share kills the gesture chain and iOS rejects the share).
   *  Resets to null when the open tile changes. */
  const [shareBlob, setShareBlob] = useState<Blob | null>(null);
  const [shareBlobError, setShareBlobError] = useState<string | null>(null);

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

  // Pre-fetch the image bytes as soon as the signed URL is available. iOS
  // Safari rejects navigator.share() if it isn't called synchronously inside
  // the user-gesture click handler — any `await` between click and share
  // kills the gesture. Loading the Blob now means the click handler can
  // construct the File + call navigator.share() with no awaits in between.
  // Also avoids the 1h presigned-URL expiry footgun: we fetch within seconds
  // of the URL minting (useImageUrl refreshes any URL <60s from expiry), so
  // the blob is in memory long before any URL could expire.
  useEffect(() => {
    if (!url) {
      setShareBlob(null);
      setShareBlobError(null);
      return;
    }
    let cancelled = false;
    setShareBlob(null);
    setShareBlobError(null);
    console.info("[lightbox] share: pre-fetch start", {
      urlPrefix: url.slice(0, 80),
    });
    fetch(url)
      .then((resp) => {
        if (!resp.ok)
          throw new Error(`pre-fetch HTTP ${resp.status}`);
        return resp.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        console.info("[lightbox] share: pre-fetch ok", {
          size: blob.size,
          type: blob.type,
        });
        setShareBlob(blob);
      })
      .catch((e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[lightbox] share: pre-fetch failed", { message, error: e });
        setShareBlobError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!view) return null;

  /**
   * Share — open the iOS native share sheet (which natively includes "Save
   * Image" alongside AirDrop, Messages, etc.) for the open tile.
   *
   * iOS Safari's user-gesture rule: navigator.share() must be invoked
   * synchronously inside the click event handler. Any `await` between the
   * click and the share call breaks the gesture chain and iOS rejects with
   * "NotAllowedError: The request is not allowed by the user agent..."
   *
   * The previous implementation did `await fetch(signedUrl); await
   * navigator.share(...)` from inside a single async click handler, which
   * triggered exactly that rejection. The catch fell through to a hidden
   * download link with no surfacing — silent failure.
   *
   * v2: we pre-fetch the blob in a useEffect when the signed URL resolves
   * (above), so by the time the user clicks Share the blob is in memory.
   * The click handler is then synchronous up to and including navigator.
   * share(); the .then/.catch on the returned promise are fine because
   * they run after iOS has already accepted the gesture.
   */
  const onShare = () => {
    if (!view) return;
    console.info("[lightbox] share: clicked", {
      tileId: view.tileId,
      hasBlob: !!shareBlob,
      shareBlobError,
    });

    // Pre-fetch hasn't completed (or failed). Surface a useful message
    // instead of dropping the click.
    if (!shareBlob) {
      const msg = shareBlobError
        ? `Couldn't prepare share — ${shareBlobError}. Tap Share again or close + reopen.`
        : "Image still loading — tap Share again in a moment.";
      setActionError(msg);
      return;
    }

    setActionError(null);
    setBusyAction("share");

    // Construct File synchronously from the in-memory blob. Filename +
    // explicit MIME type are load-bearing for iOS — the share sheet uses
    // the filename for "Save Image", and a generic blob with no name lands
    // as "image.jpg" or worse.
    const filename = `zuzi-${view.iterationId}-${view.idx + 1}.jpg`;
    const file = new File([shareBlob], filename, {
      type: shareBlob.type || "image/jpeg",
    });
    console.info("[lightbox] share: file constructed", {
      filename,
      size: file.size,
      type: file.type,
    });

    const shareData: ShareData = { files: [file], title: "Zuzi Studio" };

    const canShareThisFile =
      typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare(shareData);
    console.info("[lightbox] share: canShare check", { canShareThisFile });

    if (!canShareThisFile || typeof navigator.share !== "function") {
      // Web Share API isn't available for this file (PWA context restriction,
      // unsupported browser, etc.). Fall back to a download link constructed
      // from the in-memory blob. The user can long-press the resulting
      // image in Photos to save manually if even this doesn't land.
      console.info("[lightbox] share: fallback to download link");
      try {
        const objectUrl = URL.createObjectURL(shareBlob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke synchronously: a.click() above has already initiated the
        // browser's download with its own internal reference to the
        // underlying Blob. Per the WHATWG File API spec, revokeObjectURL
        // only invalidates the URL string for NEW fetches — the in-flight
        // download completes normally. Revoking now (instead of via a
        // 60s setTimeout, the prior pattern) avoids leaking timers + Blob
        // refs across Lightbox unmount and across repeated fallback
        // triggers. The Blob itself is still held by `shareBlob` state for
        // the lightbox's open lifetime regardless, so this is purely about
        // the ObjectURL handle.
        URL.revokeObjectURL(objectUrl);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[lightbox] share: download fallback failed", { message, error: e });
        setActionError(`Couldn't save image — ${message}`);
      } finally {
        setBusyAction(null);
      }
      return;
    }

    // Synchronous from here. DO NOT introduce an await before navigator.share()
    // — iOS user-gesture chain depends on it.
    navigator
      .share(shareData)
      .then(() => {
        console.info("[lightbox] share: shared ok");
      })
      .catch((e) => {
        // navigator.share rejects with AbortError when the user dismisses
        // the share sheet — that's the normal "user changed their mind"
        // case, not a failure. Anything else is real.
        const name = (e as Error)?.name;
        if (name === "AbortError") {
          console.info("[lightbox] share: dismissed by user");
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[lightbox] share: failed", { message, error: e });
        setActionError(`Share failed — ${message}`);
      })
      .finally(() => {
        setBusyAction(null);
      });
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
      // If the lightbox was opened from FavoritesPanel (snapshot mode),
      // the panel is still mounted at z-40 over the new source's empty
      // stream. Use-as-Source semantically means "work on this new
      // source" — leaving the panel open hides the result of the action
      // from the user. Dismiss it. Calling setFavoritesOpen(false) when
      // the panel was already closed is a no-op, so this is safe in the
      // id-mode path too.
      setFavoritesOpen(false);
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
            // IMPORTANT: onShare is synchronous (not async) and must be
            // called directly here — wrapping in `() => void onShare()` or
            // `async () => await onShare()` doesn't break iOS, but moving
            // ANY await onto the gesture path between this click and
            // navigator.share() does. The body of onShare itself is
            // sync-up-to-and-including navigator.share().
            onClick={onShare}
            disabled={busyAction !== null}
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
