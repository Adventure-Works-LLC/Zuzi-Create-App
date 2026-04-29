"use client";

/**
 * Studio — the working canvas, Krea-pattern.
 *
 * Layout (per docs/UX_INSPIRATION.md):
 *   - SourceStrip (sticky top): horizontal scroll of active sources + [+] add
 *     + Favorites button. Hidden in the empty state.
 *   - Mid-canvas: either the tile stream OR a centered Fraunces-italic cue.
 *   - InputBar (sticky bottom): preset checkboxes + Flash|Pro + 1K|4K + count
 *     + Generate. In the empty state, just shows Take photo / Choose.
 *   - Lightbox: full-bleed dark overlay when a tile is open.
 *   - FavoritesPanel: right-side drawer when favoritesOpen is true.
 *
 * Empty state: bare InputBar at the bottom of an otherwise empty canvas, with
 * a single Fraunces-italic cue centered above it. No hero, no examples, no
 * onboarding tour.
 */

import { useEffect } from "react";

import { SourceStrip } from "@/components/krea/SourceStrip";
import { TileStream } from "@/components/krea/TileStream";
import { InputBar } from "@/components/krea/InputBar";
import { Lightbox } from "@/components/krea/Lightbox";
import { FavoritesPanel } from "@/components/krea/FavoritesPanel";
import { useSources } from "@/hooks/useSources";
import { useIterations } from "@/hooks/useIterations";
import { useCanvas } from "@/stores/canvas";

export default function Studio() {
  // Boot the data hooks at the page level — components below just consume
  // store state. (useSources fetches the strip; useIterations refetches
  // whenever currentSourceId changes; useStreamingResults inside TileStream
  // wires SSE per pending iteration.)
  useSources();
  useIterations();

  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const iterations = useCanvas((s) => s.iterations);

  const isEmpty = sources.length === 0;
  const showCue =
    isEmpty || (currentSourceId !== null && iterations.length === 0);

  useEffect(() => {
    document.title = "Zuzi Studio";
  }, []);

  return (
    <main className="relative flex min-h-dvh flex-col bg-background">
      <SourceStrip />

      {iterations.length > 0 ? (
        <TileStream />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[260px]">
          {showCue && (
            <p className="caption-display max-w-[28ch] text-center text-base italic text-text-mute">
              {isEmpty
                ? "Add a painting to begin."
                : "Choose your variations and generate."}
            </p>
          )}
        </div>
      )}

      <InputBar />

      <Lightbox />
      <FavoritesPanel />
    </main>
  );
}
