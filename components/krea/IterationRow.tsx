"use client";

/**
 * IterationRow — the N tiles produced by one Submit, in a single horizontal
 * row of square tiles. Each row is one iteration; rows stack vertically with
 * newest at top inside the TileStream.
 *
 * Layout uses CSS grid with column count chosen by tile-count (1..9):
 *   - count 1 → 1 column (full width, big tile)
 *   - count 2..3 → that many columns
 *   - count 4..6 → 3 columns (wraps to 2 rows for 4..6)
 *   - count 7..9 → 3 columns, wraps as needed
 *
 * Caption above the row (small, muted): "<time> · <tier> <res>" plus preset
 * chips if any were checked. Empty preset set just shows "(make beautiful)".
 */

import { useMemo } from "react";

import { Tile } from "./Tile";
import type { Iteration } from "@/stores/canvas";

const PRESET_LABEL: Record<string, string> = {
  color: "color",
  composition: "composition",
  lighting: "lighting",
  background: "background",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function gridColsClass(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  if (count === 3) return "grid-cols-3";
  if (count <= 6) return "grid-cols-3";
  return "grid-cols-3";
}

interface IterationRowProps {
  iteration: Iteration;
}

export function IterationRow({ iteration }: IterationRowProps) {
  const optimistic = iteration.id.startsWith("opt-");
  const cols = gridColsClass(iteration.tileCount);

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
      <div className={`grid ${cols} gap-3`}>
        {iteration.tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} optimistic={optimistic} />
        ))}
      </div>
    </section>
  );
}
