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

import { useState } from "react";
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
  const { generate } = useIterations();
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      role="region"
      aria-label="Blend selection"
      // z-30 sits below z-40 panels (Favorites, Styles, ArchivedSources)
      // and z-50 lightbox/sheets. Above the InputBar (which uses
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
              Pick 2&ndash;4 tiles to blend
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
            onClick={onCancel}
            disabled={inFlight}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm no-callout",
              "text-text-mute hover:text-foreground hover:bg-secondary",
              "transition-colors disabled:opacity-50 disabled:cursor-wait",
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
