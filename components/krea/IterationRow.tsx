"use client";

/**
 * IterationRow — the N tiles produced by one Submit, in a horizontal row of
 * tiles whose container aspect ratio matches the SOURCE (AGENTS.md §3, output
 * aspect == input aspect). Each row is one iteration; rows stack vertically
 * with newest at top inside the TileStream.
 *
 * Layout invariant: tile width is determined by VIEWPORT (orientation),
 * NEVER by tile count. Generating 1 tile renders one tile at canonical width
 * with empty space to its right; generating 3 tiles renders three tiles at
 * the SAME canonical width filling the row; generating more than fits wraps
 * to a second row at the same canonical width. This is the opposite of the
 * "auto-fill / fill the row" grid behavior — tiles are size-stable so a
 * one-tile run feels like a one-tile run, not a giant single banner.
 *
 *   default (mobile, narrow):           260px wide tiles
 *   sm-and-up landscape (iPad+):        280px wide tiles
 *   sm-and-up portrait (iPad+):         360px wide tiles (more vertical air,
 *                                       less horizontal — tiles trade width
 *                                       for fewer-per-row legibility)
 *
 * The container is `flex flex-wrap`, not CSS grid with `1fr` columns, so
 * children honor their fixed width and wrap naturally.
 *
 * Caption above the row (small, muted): "<time> · <tier> <res>" plus preset
 * chips if any were checked. Empty preset set just shows "(make beautiful)".
 */

import { useMemo } from "react";

import { Tile } from "./Tile";
import { useCanvas, type Iteration } from "@/stores/canvas";

const PRESET_LABEL: Record<string, string> = {
  color: "color",
  ambiance: "ambiance",
  lighting: "lighting",
  background: "background",
};

/** Per-orientation canonical tile width. Hard-coded rather than derived from
 *  count so a 1-tile run and a 3-tile run produce visually identical tile
 *  sizes. Mobile fallback (no orientation variant) covers narrow phones. */
const TILE_WIDTH_CLASSES =
  "w-[260px] landscape:sm:w-[280px] portrait:sm:w-[360px]";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface IterationRowProps {
  iteration: Iteration;
}

export function IterationRow({ iteration }: IterationRowProps) {
  const optimistic = iteration.id.startsWith("opt-");

  // AGENTS.md §3: output aspect == input aspect. Tile containers must mirror
  // the source's aspectRatio so thumbs aren't center-cropped to square.
  // Defensive fallback to 1:1 if the source isn't in the store yet.
  const source = useCanvas((s) =>
    s.sources.find((src) => src.sourceId === iteration.sourceId),
  );
  const aspectRatio = source?.aspectRatio ?? "1:1";

  const presetLabel = useMemo(() => {
    if (iteration.presets.length === 0) return "make beautiful";
    return iteration.presets.map((p) => PRESET_LABEL[p]).join(" · ");
  }, [iteration.presets]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <span className="caption-display text-xs text-text-mute">
          <span className="text-foreground/80">{presetLabel}</span>
          <span className="mx-2 text-text-mute/50">·</span>
          {iteration.modelTier} {iteration.resolution}
          <span className="mx-2 text-text-mute/50">·</span>
          {formatTime(iteration.createdAt)}
        </span>
        {iteration.status === "failed" && (
          <span className="text-destructive text-xs">couldn&rsquo;t submit</span>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        {iteration.tiles.map((tile) => (
          <div
            key={tile.id}
            className={`flex-none ${TILE_WIDTH_CLASSES}`}
          >
            <Tile
              tile={tile}
              aspectRatio={aspectRatio}
              optimistic={optimistic}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
