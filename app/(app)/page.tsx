"use client";

/**
 * Studio — the working canvas, Krea-pattern.
 *
 * Layout (per docs/UX_INSPIRATION.md):
 *   - SourceStrip (sticky top): horizontal scroll of active sources + [+] add
 *     + archive-folder button + Favorites button. Hidden in the empty state.
 *   - Mid-canvas: either the tile stream OR a centered Fraunces-italic cue.
 *   - InputBar (sticky bottom): preset checkboxes + Flash|Pro + 1K|4K + count
 *     + Generate. In the empty state, just shows Take photo / Choose.
 *   - Lightbox: full-bleed dark overlay when a tile is open.
 *   - FavoritesPanel: right-side drawer when favoritesOpen is true.
 *   - ArchivedSourcesPanel: right-side drawer when
 *     archivedSourcesPanelOpen is true. Per-row Unarchive +
 *     Delete-forever actions.
 *   - StylesPanel: right-side drawer when stylesPanelOpen is true. Zuzi's
 *     style reference library (v2 Style Explore). Grid + Add button + per-
 *     card long-press → Delete forever. Same Esc-to-close lightbox-
 *     deference as the other two panels.
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
import { ArchivedSourcesPanel } from "@/components/krea/ArchivedSourcesPanel";
import { StylesPanel } from "@/components/krea/StylesPanel";
import { useSources } from "@/hooks/useSources";
import { useIterations } from "@/hooks/useIterations";
import { useStylePaintings } from "@/hooks/useStylePaintings";
import { useCanvas } from "@/stores/canvas";

export default function Studio() {
  // Boot the data hooks at the page level — components below just consume
  // store state. (useSources fetches the strip; useIterations refetches
  // whenever currentSourceId changes; useStreamingResults inside TileStream
  // wires SSE per pending iteration; useStylePaintings hydrates the
  // library on mount so StylesPanel + the future ExploreSheet both find
  // the data warm regardless of which surface opens first.)
  useSources();
  useIterations();
  useStylePaintings();

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
      {/* Fixed-position Sign out — ALWAYS visible regardless of source
          state, so a stuck-cookie / auth-broken scenario (which is
          exactly the state where sources fail to fetch and SourceStrip
          renders null) still has an in-app recovery affordance. Sits
          top-right above the SourceStrip's z-30 sticky header at z-40
          so it doesn't get covered when the strip is present. The
          SourceStrip itself ALSO has a Sign out anchor in its header
          when it's rendered, but that one is unreachable in the
          empty-state. This one is the safety net.

          Padding respects env(safe-area-inset-top) so it doesn't
          collide with the iPad's status bar in PWA mode. */}
      <a
        href="/logout"
        className={[
          "fixed right-4 z-40",
          "rounded-md px-3 py-2",
          "text-xs uppercase tracking-[0.18em]",
          "text-text-mute/80 hover:text-foreground",
          "bg-background/70 backdrop-blur-sm",
          "transition-colors no-callout",
        ].join(" ")}
        style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
        aria-label="Sign out"
      >
        Sign out
      </a>

      <SourceStrip />

      {iterations.length > 0 ? (
        <TileStream />
      ) : (
        <div
          className="flex flex-1 flex-col items-center justify-center px-6"
          style={{
            paddingBottom: "calc(var(--inputbar-h, 260px) + 1.5rem)",
          }}
        >
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
      <ArchivedSourcesPanel />
      <StylesPanel />
    </main>
  );
}
