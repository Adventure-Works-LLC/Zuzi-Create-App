"use client";

/**
 * BlendActionBar — floating bottom bar visible only in v3.4 blend mode.
 *
 * Shows the live selection count + per-tile cost preview + the "Blend
 * N tiles" fire button + a Cancel-mode escape. Mounts at the Studio
 * page level so it overlays the InputBar at the bottom of the
 * viewport when active. Disappears entirely when `blendMode` is off
 * (the SourceStrip's Blend toggle controls that flag).
 *
 * Fires generate({mode:'style_blend', blendTileIds}) using the
 * canvas store's modelTier (Pro by default). Cap enforcement is
 * server-side via the existing 429 path — error string surfaces
 * inline above the buttons.
 *
 * Cost preview is the same approximation pattern as the other
 * surfaces: pricePerImage × TILE_COUNT_DEFAULT (3). Multi-image
 * input may push real cost slightly higher per Gemini's pricing;
 * the server's cap check is authoritative.
 */

import { useEffect, useRef, useState } from "react";
import { Layers, Loader2, X } from "lucide-react";

import { useIterations } from "@/hooks/useIterations";
import { useCanvas } from "@/stores/canvas";
import { pricePerImage } from "@/lib/cost";
import { TILE_COUNT_DEFAULT } from "@/lib/gemini/imagePrompts";

export function BlendActionBar() {
  const blendMode = useCanvas((s) => s.blendMode);
  const blendSelectedTileIds = useCanvas((s) => s.blendSelectedTileIds);
  const setBlendMode = useCanvas((s) => s.setBlendMode);
  const modelTier = useCanvas((s) => s.modelTier);
  // v3.5: auto-exit blend mode when the current source's iterations[]
  // is empty. Happens when the user deletes every iteration mid-blend
  // or the iteration list refetches into an empty state. Without
  // this the BlendActionBar hovers over the empty-canvas cue with
  // nothing to act on. Stable iterations-length selector (number, not
  // object) keeps the subscription cheap.
  //
  // v4.4 (cross-source blend): ALSO gate on an empty selection.
  // Switching to a source with no runs mid-selection is now a normal
  // part of the flow (she's navigating sketches collecting tiles) —
  // auto-exiting there would wipe her picks. Only bail when there's
  // nothing on screen AND nothing selected.
  const iterationCount = useCanvas((s) => s.iterations.length);
  const { generate } = useIterations();
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (
      blendMode &&
      !inFlight &&
      iterationCount === 0 &&
      blendSelectedTileIds.length === 0
    ) {
      setBlendMode(false);
    }
  }, [blendMode, inFlight, iterationCount, blendSelectedTileIds, setBlendMode]);
  // v4.6.1: clear any leftover error when (re)entering blend mode. Since
  // Cancel is never disabled, a fire can fail AFTER she cancelled out —
  // that late setError used to sit invisibly and reappear as a stale
  // message on the next blend-mode entry.
  useEffect(() => {
    if (blendMode) setError(null);
  }, [blendMode]);
  // Publish the bar's height into --blendbar-h on the document root
  // so TileStream can pad its bottom by (--inputbar-h + --blendbar-h),
  // preventing the last iteration row from being clipped by the
  // floating action bar. Mirrors the InputBar.tsx ResizeObserver
  // pattern. The effect runs only while blendMode is true (the bar
  // exists in the DOM); cleanup clears the var so non-blend renders
  // don't pay extra bottom padding. The cleanup runs both on unmount
  // (blendMode → false) and on dep change (it's stable so only the
  // unmount path matters in practice).
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!blendMode) return;
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--blendbar-h", `${el.offsetHeight}px`);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => publish());
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--blendbar-h");
    };
  }, [blendMode]);

  if (!blendMode) return null;

  const count = blendSelectedTileIds.length;
  const canFire = count >= 2 && !inFlight;
  const costUsd = pricePerImage(modelTier, "1k") * TILE_COUNT_DEFAULT;

  const onCancel = () => {
    setBlendMode(false);
    setError(null);
  };

  const onFire = async () => {
    if (inFlight) return;
    if (count < 2) return;
    setInFlight(true);
    setError(null);
    try {
      const result = await generate({
        mode: "style_blend",
        blendTileIds: blendSelectedTileIds,
        // Resolution locked to 1k for v3.4 — blend's multi-image input
        // already carries cost overhead; 4k is opt-in via a future
        // per-iteration upgrade flow.
        resolution: "1k",
      });
      if (!result) {
        setError(
          "Couldn't start the blend — check the input bar for the error.",
        );
        return;
      }
      // Exit blend mode + clear selection; the new iteration lands
      // in the main TileStream automatically via the canvas store.
      setBlendMode(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Couldn't blend — ${msg}`);
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div
      ref={barRef}
      role="region"
      aria-label="Blend selection"
      // z-30 sits below z-40 panels (Favorites, Styles, ArchivedSources),
      // the z-50 ExploreSheet, and the z-[60] Lightbox. Above the InputBar (which uses
      // implicit document flow), and within the safe-area inset so
      // the iPad home-indicator gutter doesn't eat it.
      className={[
        "fixed inset-x-0 bottom-0 z-30",
        "border-t border-hairline bg-background/95 backdrop-blur-md",
      ].join(" ")}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3 px-4 py-3 sm:px-6">
        <span className="caption-display text-xs uppercase tracking-[0.18em] text-text-mute">
          Blend
        </span>
        <span className="text-sm tabular-nums">
          {count === 0 ? (
            <span className="text-text-mute">
              Pick 2&ndash;4 tiles &mdash; switch sketches to mix bases
            </span>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {count} selected
              </span>
              <span className="text-text-mute">
                {" "}
                · ~${costUsd.toFixed(2)} on{" "}
                {modelTier === "flash" ? "Flash" : "Pro"} 1K
              </span>
            </>
          )}
        </span>
        {error && (
          <span className="max-w-[260px] truncate text-xs text-destructive">
            {error}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            // v4.6: Cancel is NEVER disabled. It only exits blend mode
            // client-side — gating it on inFlight meant a hung POST
            // trapped her in blend mode (selection UI + bar) until
            // reload. An in-flight blend continues server-side and
            // streams into the TileStream regardless.
            onClick={onCancel}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm no-callout",
              "text-text-mute hover:text-foreground hover:bg-secondary",
              "transition-colors",
            ].join(" ")}
            aria-label="Exit blend mode"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            onClick={() => void onFire()}
            disabled={!canFire}
            className={[
              "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium no-callout",
              "bg-accent text-accent-foreground",
              "transition-opacity",
              canFire ? "hover:opacity-90" : "opacity-50 cursor-not-allowed",
            ].join(" ")}
            aria-label="Blend selected tiles"
          >
            {inFlight ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <Layers className="h-4 w-4" strokeWidth={1.5} />
            )}
            <span>
              {inFlight
                ? "Blending…"
                : count >= 2
                  ? `Blend ${count} tiles`
                  : "Blend"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
