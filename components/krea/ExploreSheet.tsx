"use client";

/**
 * ExploreSheet — v2.2 Idle state.
 *
 * Modal overlay (z-50, above all panels + the SourceStrip's z-30 header)
 * that drives the Style Explore entry flow. Idle state is "tell the user
 * what's about to happen + let them tap Start"; Running / Done states
 * land in v2.3. v2.2 fires + closes the sheet, so the in-flight
 * iteration shows up in the regular Studio TileStream like any other
 * generate — same SSE wiring, same per-tile placeholders, same
 * stream-into-the-grid feel. The plan's "persistent Stop + cost meter"
 * surfaces are deferred until v2.3.
 *
 * Layout (top → bottom):
 *   header  — Source thumb + filename + library size + Close (×).
 *   body    — Preview row of 6 random style thumbs (the kind of variety
 *             the run will explore). Pure visual; tap is a no-op.
 *   footer  — Flash/Pro pill, batch picker (9 / 18), live cost preview,
 *             green Start button.
 *
 * Decisions deliberately deferred from the v2 SPEC:
 *   - "Keep going" infinite-scroll batches → v2.3 (needs the Running
 *     state + IntersectionObserver to be meaningful).
 *   - 4K resolution toggle → omitted from v2.2; Explore is for discovery
 *     and the cost ceiling is Pro 4K which doesn't belong in the
 *     low-friction Idle screen. Per-tile Pro-or-4K escape is a v2.4
 *     concern in the Lightbox.
 *   - Add-styles inline affordance inside the sheet → user can close +
 *     open the Styles drawer + re-open Explore. v0.2 will add an
 *     in-sheet "+ Add styles" link.
 *
 * The sheet uses its own local tier state (default Flash) so the
 * InputBar's tier toggle (default Pro) is unaffected — Explore's
 * cheap-discovery default doesn't bleed into the Generate workflow.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Wand2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useIterations } from "@/hooks/useIterations";
import { useCanvas, type ModelTier, type StylePainting } from "@/stores/canvas";
import { pricePerImage } from "@/lib/cost";

type BatchSize = 9 | 18;

/** Fisher-Yates shuffle (non-mutating). Used to pick the random
 *  preview thumbs AND the random Start batch — same primitive so the
 *  preview gives an honest taste of what Start will run (subject to a
 *  re-roll per Start tap, of course, since each tap is a fresh
 *  iteration with its own shuffle). */
function shuffle<T>(arr: ReadonlyArray<T>): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Small square thumb used in the header (source) and in the preview row
 *  (style sample). Square crop is intentional: heterogeneous aspect
 *  ratios in the library would make the preview row visually noisy;
 *  the original full-aspect bytes still go into the Gemini call. */
function ThumbSquare({
  inputKey,
  size,
  alt,
}: {
  inputKey: string;
  size: number;
  alt: string;
}) {
  const { url } = useImageUrl(inputKey);
  return (
    <div
      style={{ width: size, height: size }}
      className="relative shrink-0 overflow-hidden rounded-md ring-1 ring-hairline/60"
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bloom-warm" aria-hidden />
      )}
    </div>
  );
}

export function ExploreSheet() {
  const open = useCanvas((s) => s.exploreSheetOpen);
  const setOpen = useCanvas((s) => s.setExploreSheetOpen);
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const stylePaintings = useCanvas((s) => s.stylePaintings);
  // Defer to Lightbox if it's open (Lightbox at z-50 too — but the
  // sheet shouldn't compete with it for Esc; the user typically opens
  // the lightbox from a tile that streamed in after they tapped Start,
  // which means the sheet's already closed. Defensive parity with the
  // FavoritesPanel + StylesPanel patterns).
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);

  const { generate, generating } = useIterations();

  // Local Idle-state UI. Tier defaults to Flash for cheaper discovery —
  // see the docstring above on why we don't reuse the InputBar's tier.
  // Batch defaults to 9 (the smaller bounded batch); user can flip to
  // 18 if their library has the depth.
  const [modelTier, setModelTier] = useState<ModelTier>("flash");
  const [batchSize, setBatchSize] = useState<BatchSize>(9);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Reset local state every time the sheet opens so a previous run's
  // tier / batch choice doesn't quietly carry over. Same lifecycle as
  // the panels' lazy-fetch-on-open pattern.
  useEffect(() => {
    if (!open) return;
    setStartError(null);
    setStarting(false);
  }, [open]);

  // Preview row: 6 random thumbs from the library. Reshuffles each open
  // so the user sees variety. Memo keyed on `open` + library snapshot so
  // we don't re-roll on every render while the sheet is open.
  const previewThumbs: StylePainting[] = useMemo(() => {
    if (!open) return [];
    return shuffle(stylePaintings).slice(0, 6);
  }, [open, stylePaintings]);

  const currentSource = sources.find((s) => s.sourceId === currentSourceId);
  const libCount = stylePaintings.length;
  // The actual batch will be min(batchSize, libCount) since we sample
  // without replacement — a library of 6 + batch=9 fires 6 tiles, not
  // 9 with duplicates. Cost preview reflects this so the displayed
  // dollar amount matches what the user will be charged.
  const effectiveBatchSize = Math.min(batchSize, libCount);
  // Cost preview always uses 1K — Explore is locked to 1K for v2.2 (see
  // sheet docstring). pricePerImage is the single source of truth for
  // pricing; lives in lib/cost.ts.
  const projectedCost = pricePerImage(modelTier, "1k") * effectiveBatchSize;

  const canClose = !starting; // don't let user close mid-fire

  // Esc-to-close, deferring to the lightbox if one is open (same
  // pattern as FavoritesPanel + StylesPanel).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key === "Escape" && canClose) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot, canClose]);

  if (!open) return null;

  // Edge case: sheet opened but the user has zero styles. The InputBar
  // disables the Explore button in this state, but defensive: render an
  // empty-state CTA pointing to the Styles drawer.
  const isEmpty = libCount === 0;
  // No active source: shouldn't happen because the InputBar's button
  // hides without sources, but defensive against a race where the user
  // archives the source mid-sheet.
  const noSource = !currentSource;

  const onStart = async () => {
    if (starting || generating) return;
    if (isEmpty || noSource) return;
    setStartError(null);
    setStarting(true);
    try {
      // Sample without replacement up to the effective batch size.
      const ids = shuffle(stylePaintings)
        .slice(0, effectiveBatchSize)
        .map((sp) => sp.id);
      const result = await generate({
        mode: "style_explore",
        stylePaintingIds: ids,
        modelTier,
        resolution: "1k",
      });
      if (result) {
        // v2.2: close the sheet on success so the iteration lands in the
        // Studio's TileStream like any other generate. v2.3 will swap
        // this for the Running-state UI that keeps the user inside the
        // sheet while tiles stream in.
        setOpen(false);
      } else {
        setStartError(
          "Couldn't start the run — see the input bar for the error.",
        );
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Explore styles"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) setOpen(false);
      }}
    >
      <div
        className={[
          "w-full max-w-[640px] flex-col",
          "rounded-2xl border border-hairline bg-background",
          "shadow-2xl",
          "flex",
        ].join(" ")}
        style={{
          maxHeight: "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2rem)",
        }}
      >
        {/* HEADER — Source thumb + library count + Close */}
        <header className="flex items-start gap-4 border-b border-hairline px-5 py-4">
          {currentSource ? (
            <ThumbSquare
              inputKey={currentSource.inputKey}
              size={64}
              alt="Current source"
            />
          ) : (
            <div className="h-16 w-16 shrink-0 rounded-md bg-secondary" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-2xl tracking-tight text-foreground">
              Explore styles
            </h2>
            <p className="mt-1 caption-display text-sm text-text-mute">
              {isEmpty
                ? "Your style library is empty."
                : `${libCount} ${libCount === 1 ? "painting" : "paintings"} in your library`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => canClose && setOpen(false)}
            disabled={!canClose}
            className={[
              "rounded-full p-2 transition-colors no-callout",
              canClose
                ? "text-text-mute hover:text-foreground hover:bg-secondary"
                : "text-text-mute/40 cursor-wait",
            ].join(" ")}
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </header>

        {/* BODY — preview row or empty-state CTA */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {isEmpty ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <p className="font-display text-lg italic text-text-mute">
                Add paintings to your style library first.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  useCanvas.getState().setStylesPanelOpen(true);
                }}
                className={[
                  "rounded-md px-4 py-2",
                  "border border-accent/60 bg-accent/10",
                  "text-sm font-medium text-accent hover:bg-accent/15",
                  "transition-colors no-callout",
                ].join(" ")}
              >
                Open style library
              </button>
            </div>
          ) : noSource ? (
            <p className="caption-display py-8 text-center text-sm italic text-text-mute">
              Pick a source first.
            </p>
          ) : (
            <>
              <p className="caption-display text-xs uppercase tracking-[0.18em] text-text-mute">
                From your library
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {previewThumbs.map((sp) => (
                  <ThumbSquare
                    key={sp.id}
                    inputKey={sp.inputKey}
                    size={64}
                    alt={sp.title ?? "Style painting"}
                  />
                ))}
              </div>
              <p className="mt-4 caption-display text-xs text-text-mute italic">
                Each tile is your sketch rendered in one of these styles. Pro
                returns one painted variation per style; you scan, favorite,
                and refine the directions that spark.
              </p>
            </>
          )}
        </div>

        {/* FOOTER — controls + Start */}
        {!isEmpty && !noSource && (
          <footer className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-4">
            {/* Tier */}
            <div
              role="group"
              aria-label="Model tier"
              className="inline-flex rounded-full border border-hairline bg-card p-0.5"
            >
              {(["flash", "pro"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setModelTier(t)}
                  className={[
                    "rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em] no-callout transition-colors",
                    modelTier === t
                      ? "bg-secondary text-foreground"
                      : "text-text-mute hover:text-foreground",
                  ].join(" ")}
                  aria-pressed={modelTier === t}
                >
                  {t === "flash" ? "Flash" : "Pro"}
                </button>
              ))}
            </div>
            {/* Batch */}
            <div
              role="group"
              aria-label="Batch size"
              className="inline-flex rounded-full border border-hairline bg-card p-0.5"
            >
              {([9, 18] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBatchSize(n)}
                  disabled={n > libCount}
                  className={[
                    "rounded-full px-3 py-1 text-xs tabular-nums no-callout transition-colors",
                    batchSize === n
                      ? "bg-secondary text-foreground"
                      : "text-text-mute hover:text-foreground",
                    n > libCount && "opacity-40 cursor-not-allowed",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={batchSize === n}
                  title={
                    n > libCount
                      ? `You only have ${libCount} styles — first batch will use all of them.`
                      : undefined
                  }
                >
                  {n}
                </button>
              ))}
            </div>
            {/* Cost preview */}
            <span className="text-xs text-text-mute tabular-nums">
              up to{" "}
              <span className="text-foreground">
                ${projectedCost.toFixed(2)}
              </span>{" "}
              ({effectiveBatchSize} × ${pricePerImage(modelTier, "1k").toFixed(3)})
            </span>
            {/* Right-aligned Start */}
            <div className="ml-auto flex items-center gap-3">
              {startError && (
                <span className="max-w-[200px] truncate text-xs text-destructive">
                  {startError}
                </span>
              )}
              <button
                type="button"
                onClick={() => void onStart()}
                disabled={starting || generating}
                className={[
                  "inline-flex items-center gap-2 rounded-full",
                  "px-5 py-2 text-sm font-medium no-callout",
                  "bg-accent text-accent-foreground",
                  "transition-opacity",
                  starting || generating
                    ? "opacity-60 cursor-wait"
                    : "hover:opacity-90",
                ].join(" ")}
              >
                {starting || generating ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      strokeWidth={1.75}
                    />
                    Starting…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4" strokeWidth={1.5} />
                    Start
                  </>
                )}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
