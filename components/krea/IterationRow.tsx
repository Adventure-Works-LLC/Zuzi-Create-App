"use client";

/**
 * IterationRow — the N tiles produced by one Submit, in a horizontal row of
 * tiles whose container aspect ratio matches the SOURCE (AGENTS.md §3, output
 * aspect == input aspect). Each row is one iteration; rows stack vertically
 * with newest at top inside the TileStream.
 *
 * Layout invariant: tile width is determined by VIEWPORT, NEVER by tile
 * count. Generating 1 tile renders one tile at canonical width with empty
 * space to its right; generating 3 tiles renders three tiles at the SAME
 * canonical width filling the row; generating more wraps at the same
 * canonical width. This is the opposite of the "auto-fill / fill the row"
 * grid behavior — tiles are size-stable so a one-tile run feels like a
 * one-tile run, not a giant single banner.
 *
 * Width formula (single CSS clamp, applied via inline style):
 *
 *     width: clamp(218px, calc((100vw - 88px) / 3), 358px)
 *
 * The middle term is the math for "exactly 3 tiles fit per row given the
 * outer container's px-8 padding (32 each side = 64) plus the two 12px
 * gaps between three tiles (= 24); 64 + 24 = 88". So at any viewport that
 * fits between the floor and the ceiling, the natural width is exactly the
 * 3-up size for that viewport.
 *
 *   - 218px floor: keeps 3-up working on iPad mini portrait (744 viewport,
 *     inner ≈ 680px). 3*218 + 24 = 678 — fits with 2px to spare.
 *   - 358px ceiling: caps tiles at the max width that fits 3-up inside the
 *     TileStream's max-w-[1100px] inner container. 3*358 + 24 = 1098 ≤
 *     1100, single row guaranteed. (The naïve 360 ceiling overflowed by
 *     4px and wrapped the 3rd tile to row 2 in landscape — verified via
 *     DOM measurement.)
 *   - Sample sizes between: iPad Pro 11 portrait (834) → 249px; iPad Pro
 *     12.9 portrait (1024) → 312px; any landscape iPad → 358px (clamps to
 *     ceiling). All fit 3-up on a single row.
 *
 * Earlier commit 9c10d52 had this inverted (portrait=360, landscape=280),
 * which made portrait wrap 3 tiles to 2 rows because 3*360 > 810. Confirmed
 * with iPad portrait math; do not revert.
 *
 * The container is `flex flex-wrap`, not CSS grid with `1fr` columns, so
 * children honor their fixed width and wrap naturally if a row genuinely
 * doesn't fit (e.g. tile_count = 9 wraps to 3 rows of 3).
 *
 * Caption above the row (small, muted): "<time> · <tier> <res>" plus preset
 * chips if any were checked. Empty preset set just shows "(make beautiful)".
 */

import { useMemo } from "react";

import { Tile } from "./Tile";
import { useCanvas, type Iteration } from "@/stores/canvas";
import { flipAspectRatio } from "@/lib/gemini/aspectRatio";

const PRESET_LABEL: Record<string, string> = {
  color: "color",
  ambiance: "ambiance",
  lighting: "lighting",
  background: "background",
};

/** Inline style for the per-tile fixed width. See file header for the
 *  derivation of the clamp values. Inline `style` instead of a Tailwind
 *  arbitrary-value class because nested `calc()` inside `clamp()` inside
 *  `w-[...]` trips up the JIT in Tailwind 4. */
const TILE_WIDTH_STYLE: React.CSSProperties = {
  width: "clamp(218px, calc((100vw - 88px) / 3), 358px)",
};

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

  // Tile containers must mirror the OUTPUT aspect ratio so thumbs aren't
  // center-cropped to square. AGENTS.md §3 originally pinned this to the
  // source's aspect ratio (output == input invariant); the InputBar's new
  // "Aspect: Match | Flip" toggle introduces a per-iteration mode that
  // mirrors W:H when set to 'flip'. Display aspect = source aspect under
  // 'match', flipped source aspect under 'flip'. Defensive fallback to 1:1
  // if the source isn't in the store yet (cross-source FavoritesPanel
  // iterations from archived sources, etc.).
  const source = useCanvas((s) =>
    s.sources.find((src) => src.sourceId === iteration.sourceId),
  );
  const sourceAspect = source?.aspectRatio ?? "1:1";
  const aspectRatio =
    iteration.aspectRatioMode === "flip"
      ? flipAspectRatio(sourceAspect)
      : sourceAspect;

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
          // Two paths land here:
          //   - optimistic id (`opt-...`) → POST /api/iterate failed before the
          //     worker ever ran. "couldn't submit" matches the UX.
          //   - real iteration id with all tiles blocked/failed → the worker
          //     ran but produced 0 successful tiles. Each tile renders its own
          //     blocked/failed indicator inside, so the caption just needs to
          //     say "the whole iteration failed, retry."
          <span className="text-destructive text-xs">
            {iteration.id.startsWith("opt-") ? "couldn’t submit" : "no tiles generated — try again"}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        {iteration.tiles.map((tile) => (
          <div
            key={tile.id}
            className="flex-none"
            style={TILE_WIDTH_STYLE}
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
