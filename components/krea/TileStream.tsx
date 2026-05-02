"use client";

/**
 * TileStream — vertical scroll of iterations against the current source,
 * newest at top. Each iteration is its own IterationRow.
 *
 * Wires the streaming hook (per-iteration EventSource) so live tile updates
 * land in the store without each row managing its own SSE connection.
 *
 * Layout: takes flex-1 so it fills the canvas between SourceStrip and
 * InputBar. Has bottom-padding equal to the InputBar's height so the last
 * tile is never obscured under the sticky bar.
 *
 * Subscription model (perf-critical — see also IterationRow + Tile):
 *   TileStream subscribes ONLY to the iteration ids in render order plus a
 *   per-iteration tuple of (id, sourceAspectRatio, aspectRatioMode). Both
 *   selectors use `useShallow` so a new iterations[] array reference from
 *   `updateTile` (which fires once per SSE tile event) does NOT re-render
 *   TileStream as long as ids + sources haven't changed. IterationRow then
 *   subscribes to its own iteration object internally and only re-renders
 *   when that single iteration's reference changes (i.e. when one of ITS
 *   tiles updates). Net effect: an SSE event for tile N reconciles only
 *   the IterationRow that owns it, not the whole stream.
 *
 *   Source aspect-ratio lookup is hoisted here (rather than each IterationRow
 *   doing `sources.find(...)`) so the find runs once per render across all
 *   rows instead of once per row, and so IterationRow doesn't need to
 *   subscribe to sources[] at all.
 */

import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { IterationRow } from "./IterationRow";
import { useStreamingResults } from "@/hooks/useStreamingResults";
import { useCanvas } from "@/stores/canvas";
import { flipAspectRatio } from "@/lib/gemini/aspectRatio";

interface IterationDescriptor {
  id: string;
  /** Pre-resolved display aspect ratio = source aspect (with flip applied
   * if the iteration's mode is 'flip'). Computed in TileStream so each
   * IterationRow doesn't need to walk sources[] on every store mutation. */
  aspectRatio: string;
}

export function TileStream() {
  useStreamingResults();

  // Pull the minimal tuple per iteration that drives layout/identity.
  // useShallow makes this re-render only when the array of tuples
  // shallow-changes — i.e. iteration added/removed/reordered, source aspect
  // ratio for an iteration's source changed, or aspectRatioMode changed.
  // Tile-only updates leave this slice referentially stable.
  const descriptors = useCanvas(
    useShallow((s) => {
      // Build a one-shot map for source lookup so we're O(N+M) per slice
      // instead of O(N*M).
      const sourceAspectById = new Map<string, string>();
      for (const src of s.sources) {
        sourceAspectById.set(src.sourceId, src.aspectRatio);
      }
      return s.iterations.map<IterationDescriptor>((it) => {
        const sourceAspect = sourceAspectById.get(it.sourceId) ?? "1:1";
        const aspectRatio =
          it.aspectRatioMode === "flip"
            ? flipAspectRatio(sourceAspect)
            : sourceAspect;
        return { id: it.id, aspectRatio };
      });
    }),
  );

  const newestId = descriptors[0]?.id;
  const containerRef = useRef<HTMLDivElement>(null);

  // When a new iteration lands at the top, scroll the container to top so the
  // user sees the newly-arriving placeholders immediately. Only auto-scroll if
  // the user is already near the top — don't yank them away from the older
  // tile they were inspecting.
  useEffect(() => {
    if (!newestId) return;
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop < 200) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [newestId]);

  // Stable rendered list — the iteration row props are primitives so
  // React.memo on IterationRow short-circuits cleanly.
  const rows = useMemo(
    () =>
      descriptors.map((d) => (
        <IterationRow
          key={d.id}
          iterationId={d.id}
          aspectRatio={d.aspectRatio}
        />
      )),
    [descriptors],
  );

  if (descriptors.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className={[
        "flex-1 overflow-y-auto",
        "px-4 sm:px-6 md:px-8",
        // Top padding clears the source strip; bottom padding clears the
        // sticky InputBar. --inputbar-h is published by InputBar via a
        // ResizeObserver so this tracks wraps, error rows, and PWA safe-area-
        // inset additions. Fallback 280px keeps SSR / first-paint correct.
        "pt-6",
        "scroll-smooth",
      ].join(" ")}
      style={{
        paddingBottom: "calc(var(--inputbar-h, 280px) + 1.5rem)",
      }}
    >
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-10">
        {rows}
      </div>
    </div>
  );
}
