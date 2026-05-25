"use client";

/**
 * Lightbox — full-bleed dark single-image view.
 *
 * Toolbar (bottom of the viewport):
 *   - Use as Source (uploads the rendered tile back as a new source row,
 *     making it the current source for the next generate)
 *   - Share (Web Share API → save to camera roll / AirDrop / Messages)
 *   - Compare (toggles the Compare-with-Original split layout)
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
 *
 * Compare mode: shows the original painting alongside the generated tile so
 * Zuzi can A/B them at full size. Splits horizontally on landscape iPad,
 * stacks vertically on portrait so each image gets the full inner width
 * (~800px) — two portrait paintings side-by-side at 834px viewport leaves
 * each image too small to see brushwork. Toggle persists per-tile until the
 * lightbox closes or the user switches to another tile (then resets to
 * single-view, which is the right default for "open a tile to look at it").
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  Columns2,
  Loader2,
  Share2,
  Sparkles,
  Star,
  Wand2,
  X,
} from "lucide-react";

import { useCanvas } from "@/stores/canvas";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useFavorites } from "@/hooks/useFavorites";
import { useIterations } from "@/hooks/useIterations";
import { useShare } from "@/hooks/useShare";
import { useSources } from "@/hooks/useSources";
import { authFetch } from "@/lib/auth/authFetch";
import { TILE_COUNT_DEFAULT } from "@/lib/gemini/imagePrompts";

/** Flat view used by the rendering layer regardless of how the lightbox was
 *  opened. `byId` mode (Tile.tsx → walk iterations[]) and `snapshot` mode
 *  (FavoritesPanel.tsx → cross-source) both resolve to this shape. */
interface LightboxView {
  tileId: string;
  iterationId: string;
  idx: number;
  outputKey: string | null;
  isFavorite: boolean;
  /** R2 key for the source painting that produced this tile, or null if
   *  the source isn't reachable from current state (e.g. the by-id path
   *  during an in-flight source archive). Used by Compare mode to render
   *  the original alongside the generated tile. Null is the "no compare"
   *  signal — the Compare button stays hidden in that defensive case. */
  sourceInputKey: string | null;
  /** v2.4: per-tile style attribution. When non-null, the toolbar
   *  swaps "Use as source" → "Iterate on this direction" + Compare's
   *  target becomes the style painting (not the source). NULL for
   *  v1-style prompt-mode tiles. Resolved from tile.stylePaintingId
   *  in both by-id and snapshot paths. */
  stylePaintingId: string | null;
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
  // For the by-id path (Tile.tsx → walk iterations[]) we resolve the
  // source's R2 key by iteration.sourceId → sources[]. The snapshot path
  // (FavoritesPanel) ships sourceInputKey on the snapshot itself because
  // archived sources aren't loaded into sources[] and a store lookup
  // would miss. sources[] is short (3-10 active items) so this selector
  // is essentially free; the lightbox re-renders on store changes anyway.
  const sources = useCanvas((s) => s.sources);

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
        // Snapshot already carries the source's R2 key — populated by
        // FavoritesPanel from the server-side join. No store fallback
        // needed; the snapshot path is self-contained.
        sourceInputKey: lightboxSnapshot.sourceInputKey,
        stylePaintingId: lightboxSnapshot.stylePaintingId,
      };
    }
    if (lightboxTileId !== null) {
      for (const it of iterations) {
        const t = it.tiles.find((x) => x.id === lightboxTileId);
        if (t) {
          // Resolve sourceInputKey from the canvas store. For the by-id
          // path the iteration is in iterations[] (current source's
          // stream), and the source must be in sources[] to be the
          // current source — so this lookup almost always hits. The
          // null fallback handles the edge case of an in-flight source
          // archive where iterations[] still has rows but sources[]
          // already filtered the source out (the lightbox stays usable
          // for single-view; Compare button hides defensively).
          const src = sources.find((s) => s.sourceId === it.sourceId);
          return {
            tileId: t.id,
            iterationId: it.id,
            idx: t.idx,
            outputKey: t.outputKey,
            isFavorite: t.isFavorite,
            sourceInputKey: src?.inputKey ?? null,
            stylePaintingId: t.stylePaintingId,
          };
        }
      }
    }
    return null;
  })();

  const fullKey = view?.outputKey ?? null;
  const { url } = useImageUrl(fullKey);
  // v2.4: Compare target depends on whether the tile is style_explore
  // (or prompt-mode spawned from one). When stylePaintingId is set,
  // the Compare toggle shows result + style painting (the reference
  // Pro was channeling); when null, the v1 behavior — result + source.
  // Resolve the style painting from the canvas store's hydrated
  // library; renders a null-fallback in the missing-row case (style
  // deleted between generation + viewing).
  const stylePaintings = useCanvas((s) => s.stylePaintings);
  const stylePaintingForView = view?.stylePaintingId
    ? stylePaintings.find((sp) => sp.id === view.stylePaintingId) ?? null
    : null;
  // Compare key picks style over source when the tile carries a style
  // attribution. Falls back to source for v1-style tiles. The fallback
  // path also handles the "style painting deleted mid-view" case —
  // stylePaintingForView is null and we revert to source-compare.
  const compareKey: string | null = view?.stylePaintingId
    ? stylePaintingForView?.inputKey ?? view.sourceInputKey
    : view?.sourceInputKey ?? null;
  // useImageUrl no-ops cleanly when the key is null (returns
  // { url: null }), so threading the same hook here is safe even when
  // there's nothing to compare against.
  const { url: compareUrl } = useImageUrl(compareKey);
  const { toggle } = useFavorites();
  const { canShare } = useShare();
  const { promoteFromTile } = useSources();
  const { generate } = useIterations();
  const [busyAction, setBusyAction] = useState<
    "share" | "use" | "iterate" | "more" | null
  >(null);
  /** Compare-with-Original split layout toggle. Off by default — most
   *  lightbox opens are "tap a tile to look at it", and forcing the user
   *  to dismiss a split view they didn't ask for would be hostile. Resets
   *  on tile switch and on close (see effects below). */
  const [compareOpen, setCompareOpen] = useState(false);
  /** Visible error string for whichever action just failed. Cleared on the
   *  next attempt or close. Replaces the prior swallowed-to-console.warn
   *  pattern that hid Use-as-Source breakage entirely. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Pre-fetched image bytes for the Share path. Loaded on the user's FIRST
   *  intent-to-share signal (Share button onPointerDown/onTouchStart, both
   *  of which fire before onClick and are still inside the iOS user-gesture
   *  chain) so that when the click handler runs we can construct the File
   *  + call navigator.share() synchronously — which is what iOS Safari
   *  requires (any `await` between user gesture and navigator.share kills
   *  the gesture chain and iOS rejects the share).
   *
   *  Why intent-driven instead of mount-driven: most lightbox opens are
   *  "tap to look closer, close" without sharing. Pre-fetching on every
   *  open pulled 150KB–2MB through the Next/Railway server even when the
   *  user never shared. The pointer/touch-down hook fires ~50–150ms before
   *  the click resolves, which is enough headroom on iPad to have the
   *  Blob ready by the time the click handler runs in the common case.
   *
   *  In-component cache via the `shareBlobCacheRef` keyed on the R2 key:
   *  a second tap on Share within the same lightbox open (e.g., the user
   *  cancels the first share sheet then taps again) reuses the in-memory
   *  Blob without re-hitting the proxy. The cache lives only as long as
   *  the component is mounted and is keyed by `fullKey` so switching
   *  tiles invalidates correctly. */
  const [shareBlob, setShareBlob] = useState<Blob | null>(null);
  const [shareBlobError, setShareBlobError] = useState<string | null>(null);
  const [sharePrefetching, setSharePrefetching] = useState(false);
  /** Per-key in-flight + completed Blob cache. Keyed on R2 key (fullKey)
   *  so switching to a different tile in the same lightbox open won't
   *  return a stale Blob. Cleared on unmount via the cleanup effect below. */
  const shareBlobCacheRef = useRef<Map<string, Blob | Promise<Blob>>>(
    new Map(),
  );

  /** Close clears both state slots, any inline error, and Compare mode.
   *  Either mode can have been the opener. */
  const closeLightbox = () => {
    setLightboxTile(null);
    setLightboxSnapshot(null);
    setActionError(null);
    setCompareOpen(false);
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

  // Reset Compare mode when the open tile changes — switching tiles inside
  // an open lightbox (e.g. via removeIteration redirecting; or a future
  // swipe-between-tiles flow) should land on the default single view, not
  // inherit the previous tile's split state. Keyed on view?.tileId so the
  // change fires exactly when a new tile is the target. Also auto-collapse
  // if sourceInputKey becomes null mid-view (defensive against an
  // in-flight source archive).
  useEffect(() => {
    setCompareOpen(false);
  }, [view?.tileId]);
  useEffect(() => {
    // Auto-collapse compare mode when there's nothing to compare against
    // (defensive — by-id path during in-flight source archive; or the
    // v2.4 style-target case where the style painting was hard-deleted
    // between view-open and compareKey-resolution).
    if (view && compareKey === null && compareOpen) {
      setCompareOpen(false);
    }
  }, [view, compareKey, compareOpen]);

  // Reset Share state whenever the open tile (R2 key) changes. The actual
  // pre-fetch is INTENT-DRIVEN now (fired from the Share button's
  // onPointerDown/onTouchStart) rather than mount-driven, so this effect
  // is just a clean-slate on key change — no network call here.
  //
  // History: previous versions kicked the pre-fetch immediately on every
  // lightbox-open via a `useEffect[fullKey]`. That pulled 150KB–2MB
  // through the Next/Railway server every "tap to look closer, close"
  // — by far the most common interaction. Moving the trigger to the
  // user's intent-to-share signal eliminates the wasted bandwidth in
  // the no-share case while preserving iOS gesture-chain compatibility
  // (pointer/touch-down fires before click and is still inside the
  // gesture chain — see startSharePrefetch below).
  //
  // The proxy still handles two concerns and the rest of the file's
  // assumptions are unchanged:
  //   (a) iOS Safari rejects navigator.share() if it isn't called
  //       synchronously inside the user-gesture click handler — any
  //       `await` between click and share kills the gesture chain.
  //       Pre-fetching on pointer-down means the Blob is in memory by
  //       the time the click handler runs.
  //   (b) The fetch routes through our same-origin /api/image-bytes
  //       proxy, NOT the R2 signed URL directly. R2 doesn't return CORS
  //       headers by default, so a direct cross-origin fetch fails with
  //       "TypeError: Load failed" on iPad PWA — the proxy makes the
  //       request same-origin so CORS is moot.
  useEffect(() => {
    setShareBlob(null);
    setShareBlobError(null);
    setSharePrefetching(false);
    // Drop any prior cache entries — switching tiles must not return the
    // previous tile's Blob to a Share click. The Map itself is reused
    // across renders (the ref is stable); only its entries are cleared.
    shareBlobCacheRef.current.clear();
  }, [fullKey]);

  /** Intent-driven Share prefetch. Called from the Share button's
   *  onPointerDown / onTouchStart (both fire before onClick and stay
   *  inside the iOS user-gesture chain), and idempotent within a single
   *  lightbox open via an in-component Map keyed on `fullKey`:
   *
   *    - First call: kicks off the proxy fetch, stores the in-flight
   *      Promise in the cache, sets sharePrefetching=true so the button
   *      can show progress if the user lingers.
   *    - Subsequent calls (same key): no-op if the Blob is already
   *      resolved; await the existing in-flight Promise otherwise.
   *
   *  The Blob lands in `shareBlob` state so onShare can construct the
   *  File synchronously from the click handler. Errors land in
   *  `shareBlobError` and surface through onShare's existing path. */
  const startSharePrefetch = (key: string) => {
    const cache = shareBlobCacheRef.current;
    const existing = cache.get(key);
    if (existing) {
      // Already resolved: nothing to do — shareBlob state already set.
      if (existing instanceof Blob) return;
      // In-flight: don't re-trigger the network or reset the state.
      return;
    }

    const proxyUrl = `/api/image-bytes?key=${encodeURIComponent(key)}`;
    console.info("[lightbox] share: pre-fetch start (intent)", { proxyUrl });
    setSharePrefetching(true);
    setShareBlobError(null);

    // `cache: "no-store"` is belt-and-suspenders — the SW skips /api/* per
    // scripts/sw-template.js, and the endpoint sets Cache-Control: no-store
    // — but explicit hint here means anyone reading the call-site knows
    // the intent without chasing through the proxy + SW config.
    const inflight = authFetch(proxyUrl, { cache: "no-store" })
      .then((resp) => {
        if (!resp.ok) {
          throw new Error(
            `pre-fetch HTTP ${resp.status}${resp.statusText ? ` (${resp.statusText})` : ""}`,
          );
        }
        return resp.blob();
      })
      .then((blob) => {
        // Stale-key guard: while the pre-fetch was in flight, the user
        // may have switched tiles (the reset effect above cleared the
        // cache and shareBlob state). Ignore the result if so.
        if (cache.get(key) === inflight) cache.set(key, blob);
        if (fullKey === key) {
          console.info("[lightbox] share: pre-fetch ok", {
            size: blob.size,
            type: blob.type,
          });
          setShareBlob(blob);
          setSharePrefetching(false);
        }
        return blob;
      })
      .catch((e) => {
        // Surface as much diagnostic detail as possible. The previous bug
        // class (CORS) showed up as `TypeError: Load failed` with no other
        // signal; logging name + message + error helps future failures
        // localize faster from production console output.
        const errName =
          e instanceof Error && typeof e.name === "string" ? e.name : "unknown";
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[lightbox] share: pre-fetch failed", {
          proxyUrl,
          errName,
          message,
          error: e,
        });
        // Clear the cache entry so a retry (second tap) can re-fetch
        // instead of re-using a rejected promise.
        if (cache.get(key) === inflight) cache.delete(key);
        if (fullKey === key) {
          setShareBlobError(`${errName}: ${message}`);
          setSharePrefetching(false);
        }
        throw e;
      });

    cache.set(key, inflight);
  };

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
   * v2: we pre-fetch the blob on the user's intent-to-share signal —
   * Share button onPointerDown / onTouchStart, both of which fire BEFORE
   * onClick and stay inside the iOS user-gesture chain — so by the time
   * the click handler runs the blob is usually in memory. The click
   * handler is then synchronous up to and including navigator.share();
   * the .then/.catch on the returned promise are fine because they run
   * after iOS has already accepted the gesture.
   *
   * Why intent-driven instead of mount-driven: most lightbox opens are
   * "tap to look closer, close" without any share. Pre-fetching on every
   * open burned 150KB–2MB of Railway egress per look. Pointer/touch-down
   * runs ~50–150ms before the click resolves, which is enough headroom
   * on iPad to have the Blob ready in the common case.
   */
  const onShare = () => {
    if (!view) return;
    console.info("[lightbox] share: clicked", {
      tileId: view.tileId,
      hasBlob: !!shareBlob,
      sharePrefetching,
      shareBlobError,
    });

    // Pre-fetch hasn't completed (or failed). Surface a useful message
    // instead of dropping the click. Common case here: the user clicked
    // Share so quickly that pointer-down's fetch is still in flight —
    // tapping again ~200ms later usually finds the Blob ready.
    if (!shareBlob) {
      // Best-effort: ensure the prefetch is at least started, in case the
      // click somehow arrived without a preceding pointer-down (rare on
      // touch devices but possible with assistive tech / keyboard).
      if (fullKey) startSharePrefetch(fullKey);
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

  /**
   * v2.4: "Iterate on this direction" — for style_explore tiles (and
   * prompt-mode tiles spawned via a prior handoff). Fires a new
   * prompt-mode iteration against the CURRENT source with:
   *   - parentTileId = this tile's id (provenance link recorded on
   *     iterations.parent_tile_id; surfaces in the IterationRow's
   *     header in a future iteration of the UI).
   *   - stylePaintingId = this tile's style_painting_id (copied to
   *     every tile of the new iteration; the worker pulls the style
   *     as second image input and prepends the style-reference
   *     sentence to the preset body).
   *   - presets = ['avery']  → the painter-reference preset is the
   *     canonical default for style-direction refinement (matches the
   *     canvas store's preset default; gives Pro a strong painterly
   *     anchor while preserving the figure).
   * The new iteration lands in the regular Studio TileStream (the
   * Lightbox closes; ExploreSheet closes if it was open behind).
   */
  const onIterateOnThisDirection = async () => {
    if (!view) return;
    if (!view.stylePaintingId) return;
    if (view.tileId.startsWith("opt-")) {
      setActionError(
        "Optimistic tile not yet finalized — wait a moment and try again.",
      );
      return;
    }
    setBusyAction("iterate");
    setActionError(null);
    try {
      const result = await generate({
        mode: "prompt",
        parentTileId: view.tileId,
        stylePaintingId: view.stylePaintingId,
      });
      if (!result) {
        // generate set its own error string; surface to the user.
        setActionError(
          "Couldn't start the iteration — check the input bar for the error.",
        );
        return;
      }
      // Close the lightbox + any open Explore sheet + the FavoritesPanel
      // so the user lands back in the Studio stream watching their new
      // iteration arrive. Snapshot-mode opens come from FavoritesPanel
      // (z-40 over Studio); without dismissing it, the panel stays
      // covering the new iteration that's now streaming in. Mirrors
      // onUseAsSource's setFavoritesOpen(false) pattern.
      closeLightbox();
      useCanvas.getState().setExploreSheetOpen(false);
      setFavoritesOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(`Couldn't iterate — ${msg}`);
    } finally {
      setBusyAction(null);
    }
  };

  /**
   * v2.7: "More like this" — sibling to "Iterate on this direction"
   * with a different semantic. Same (sketch + style) pair, but routed
   * through `mode: 'style_explore'` so the worker uses the locked
   * Krea-validated directive verbatim — no preset overlay, pure
   * variation. The duplicate-id array (`[id, id, id]`) is intentional:
   * the route + worker already handle it (route accepts duplicates by
   * design — see comment in app/api/iterate/route.ts; worker dedupes
   * the R2 prefetch via Set so one style image is fetched once
   * regardless of how many tiles reference it).
   *
   * Why distinct from "Iterate on this direction":
   *   - That fires `mode: 'prompt'` with presets=['avery'] + style as
   *     second image input → refinement through the Avery painter
   *     preset on top of the style.
   *   - This fires `mode: 'style_explore'` with the same style → pure
   *     variation, no preset. Same prompt bytes Zuzi originally saw +
   *     liked from the Explore grid.
   * Both are reachable side-by-side when `view.stylePaintingId` is set;
   * the user picks "refine" vs "more of the same" per tile.
   *
   * Lands in the main Studio TileStream as a fresh style_explore
   * iteration. parent_tile_id is NOT set — that field is reserved for
   * the prompt-mode handoff per AGENTS.md §13 invariant 4. Provenance
   * for "all the tiles I generated against this style" lives on
   * `tiles.style_painting_id` (every tile of every "more" iteration
   * carries the same id, so the join is trivial).
   *
   * Count = `TILE_COUNT_DEFAULT` (3). Tier inherits from the
   * InputBar's current setting (Pro by default) — the drill is a
   * stream-level action, so it takes the stream-level tier choice,
   * not the ExploreSheet's discovery-oriented Flash default.
   */
  const onMoreLikeThis = async () => {
    if (!view) return;
    if (!view.stylePaintingId) return;
    if (view.tileId.startsWith("opt-")) {
      setActionError(
        "Optimistic tile not yet finalized — wait a moment and try again.",
      );
      return;
    }
    setBusyAction("more");
    setActionError(null);
    try {
      const result = await generate({
        mode: "style_explore",
        stylePaintingIds: Array(TILE_COUNT_DEFAULT).fill(view.stylePaintingId),
      });
      if (!result) {
        setActionError(
          "Couldn't start the run — check the input bar for the error.",
        );
        return;
      }
      // Same dismiss pattern as onIterateOnThisDirection so the user
      // lands back in the Studio stream watching the new iteration
      // arrive. Both surfaces close: Lightbox + ExploreSheet (if open
      // behind) + FavoritesPanel (if the lightbox was opened from a
      // favorited tile in snapshot mode).
      closeLightbox();
      useCanvas.getState().setExploreSheetOpen(false);
      setFavoritesOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionError(`Couldn't generate more — ${msg}`);
    } finally {
      setBusyAction(null);
    }
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
          area and the toolbar stays anchored at the bottom.

          In Compare mode the single <img> swap to a flex split: rows in
          landscape, columns in portrait. Two portrait paintings (Zuzi's
          typical 4:5) side-by-side at iPad portrait (834x1194) leaves each
          image only ~390px wide — too small to see brushwork; stacking
          gives each ~800px. Each half independently letterboxes its image
          via object-contain, which handles the 'flip' case (source 4:5
          portrait, generated 5:4 landscape) gracefully — neither side
          crops to the other's aspect. */}
      {!compareOpen ? (
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
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 landscape:flex-row"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeLightbox();
          }}
        >
          {/* Compare target (left in landscape, top in portrait). For
              v1-style prompt-mode tiles this is the source painting;
              for v2.4 style_explore tiles it's the style painting Pro
              was channeling. The compareKey + compareUrl already
              resolve the right target. Label flips accordingly so the
              user knows what they're comparing against. */}
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeLightbox();
            }}
          >
            {compareKey && compareUrl ? (
              <img
                src={compareUrl}
                alt=""
                className="max-h-full max-w-full rounded-md object-contain"
              />
            ) : compareKey ? (
              <Loader2 className="h-8 w-8 text-text-mute animate-spin" />
            ) : (
              <div className="bloom-warm flex h-32 w-32 items-center justify-center rounded-md">
                <span className="caption-display text-xs italic text-text-mute">
                  {view.stylePaintingId
                    ? "style unavailable"
                    : "original unavailable"}
                </span>
              </div>
            )}
            <span className="caption-display text-xs text-text-mute/80">
              {view.stylePaintingId ? "Style" : "Original"}
            </span>
          </div>
          {/* Generated (right in landscape, bottom in portrait). */}
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2"
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
            <span className="caption-display text-xs text-text-mute/80">
              Generated
            </span>
          </div>
        </div>
      )}

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
        {view.stylePaintingId ? (
          // v2.4 + v2.7: style_explore tiles (and prompt-mode tiles
          // spawned via prior handoff) get TWO paired toolbar actions
          // instead of "Use as source". The semantic split is
          // intentional: "Iterate on this direction" is refinement
          // (Avery painter preset on top of the style); "More like
          // this" is pure variation (same locked directive, no
          // preset). Both reuse the same (sketch + style) inputs;
          // they differ only in whether the preset ladder fires.
          // Match the plan's lightbox contract + AGENTS.md §13.
          <>
            <button
              type="button"
              onClick={() => void onIterateOnThisDirection()}
              disabled={!url || busyAction !== null}
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 no-callout"
            >
              {busyAction === "iterate" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" strokeWidth={1.5} />
              )}
              Iterate on this direction
            </button>
            <button
              type="button"
              onClick={() => void onMoreLikeThis()}
              disabled={!url || busyAction !== null}
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 no-callout"
              title={`Generate ${TILE_COUNT_DEFAULT} more tiles using the same sketch + style — pure variation, no preset.`}
            >
              {busyAction === "more" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" strokeWidth={1.5} />
              )}
              More like this
            </button>
          </>
        ) : (
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
        )}
        {canShare && (
          <button
            type="button"
            // IMPORTANT: onShare is synchronous (not async) and must be
            // called directly here — wrapping in `() => void onShare()` or
            // `async () => await onShare()` doesn't break iOS, but moving
            // ANY await onto the gesture path between this click and
            // navigator.share() does. The body of onShare itself is
            // sync-up-to-and-including navigator.share().
            //
            // onPointerDown + onTouchStart fire before onClick and are
            // both inside the iOS user-gesture chain. We use them to kick
            // off the proxy fetch as early as possible so the Blob is
            // typically ready by the time onClick runs. Both are wired
            // because onPointerDown isn't reliable on every iPad webview
            // (some PWA contexts only fire touch events). startSharePrefetch
            // is idempotent + cached on fullKey so two events firing for
            // one tap is just a no-op.
            onPointerDown={() => {
              if (fullKey && !shareBlob) startSharePrefetch(fullKey);
            }}
            onTouchStart={() => {
              if (fullKey && !shareBlob) startSharePrefetch(fullKey);
            }}
            onClick={onShare}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors disabled:opacity-50 no-callout"
          >
            {busyAction === "share" || sharePrefetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" strokeWidth={1.5} />
            )}
            Share
          </button>
        )}
        {/* Compare toggle. Sits between Share and Favorite — same group
            of "secondary" actions before Close. Hidden when compareKey
            is null (defensive — by-id path during in-flight source
            archive; v2.4 style_explore tile with deleted style painting
            falls back to source-compare so it stays available there).
            For style_explore tiles the OFF state label reads "Compare
            with style"; for v1 tiles it remains "Compare". When ON
            (split view rendered), the button text drops to just
            "Style"/"Original" — matches the existing pattern that
            previously toggled to "Original" on activation. The label
            must agree with what compareKey actually points at: if the
            tile is style_explore-derived BUT the style painting was
            hard-deleted (compareKey falls back to the source), the
            label reads "Original" so the user isn't told they're
            looking at a style painting when they're really seeing the
            source. */}
        {compareKey !== null && (
          <button
            type="button"
            onClick={() => setCompareOpen((v) => !v)}
            aria-pressed={compareOpen}
            className={[
              "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors no-callout",
              compareOpen
                ? "border-[#C9A878]/50 bg-[#C9A878]/15 text-[#E0BE8C]"
                : "border-white/20 bg-white/5 text-white hover:bg-white/10",
            ].join(" ")}
          >
            <Columns2 className="h-4 w-4" strokeWidth={1.5} />
            {compareOpen
              ? view.stylePaintingId && stylePaintingForView
                ? "Style"
                : "Original"
              : "Compare"}
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
