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
 *   TileStream subscribes to TWO primitive-string slices, both
 *   `useShallow`-stable:
 *     1. `iterationIds` — the ids in render order. New iterations
 *         added/removed/reordered changes this; tile-level updates do NOT.
 *     2. `iterationAspectShape` — a flat `[id, sourceId, mode]` tuple per
 *         iteration. Captures the inputs to display-aspect resolution
 *         without leaking object identity into the selector result.
 *   Plus the `sources` array directly (rare to change — only on
 *   archive/upload/delete).
 *
 *   Why all-primitives in the selectors: React 19 is strict about
 *   `useSyncExternalStore` snapshot stability — `getSnapshot` MUST return
 *   the same reference when nothing meaningful changed, OR React loops
 *   until it bails with error #185 ("Maximum update depth exceeded").
 *   `useShallow` provides that stability by doing element-by-element
 *   `Object.is` on the returned array. That works for primitive elements
 *   (strings, numbers) but FAILS for object elements like
 *   `{id, aspectRatio}` because `Object.is(freshObj, freshObj)` is always
 *   `false`. An earlier version of this file returned an array of
 *   `{id, aspectRatio}` descriptors and shipped to production with that
 *   exact loop crashing iPad Safari + Chrome. Don't do that — keep the
 *   selector value flat-primitive.
 *
 *   The display-aspect-ratio computation now happens in a `useMemo`
 *   downstream of the stable selectors (NOT inside the selector), so each
 *   render still passes a fresh `aspectRatio` string to IterationRow but
 *   the computation only re-runs when one of its primitive deps actually
 *   changed. IterationRow itself subscribes to its own iteration object
 *   internally and only re-renders when that single iteration's reference
 *   changes (i.e. when one of ITS tiles updates).
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

  // Slice 1: iteration ids in render order. Primitive strings — useShallow
  // shallow-compares them with Object.is and gives a stable reference when
  // nothing structural changed. Re-renders only when iterations are
  // added/removed/reordered.
  const iterationIds = useCanvas(
    useShallow((s) => s.iterations.map((it) => it.id)),
  );

  // Slice 2: flat tuple per iteration capturing the inputs to display-
  // aspect resolution: `[id, sourceId, mode]`. Same rationale as #1 — flat
  // primitives so useShallow can stably memoize. Re-renders only when an
  // iteration's source or aspect-mode changes.
  const iterationAspectShape = useCanvas(
    useShallow((s) =>
      s.iterations.flatMap((it) => [it.id, it.sourceId, it.aspectRatioMode]),
    ),
  );

  // Slice 3: sources are short (3-10 active). Subscribing to the array is
  // cheap; sources rarely change (only on archive/upload/delete).
  const sources = useCanvas((s) => s.sources);

  // Compute the descriptors HERE, outside the zustand selector. Inputs are
  // the three stable slices above; useMemo's dep array uses them as
  // primitives + the sources array reference. Output is a fresh array
  // each time inputs change — fine, because this isn't a getSnapshot
  // result, just a derived render value.
  const descriptors = useMemo<IterationDescriptor[]>(() => {
    const sourceAspectById = new Map<string, string>();
    for (const src of sources) {
      sourceAspectById.set(src.sourceId, src.aspectRatio);
    }
    const out: IterationDescriptor[] = [];
    for (let i = 0; i < iterationIds.length; i++) {
      const id = iterationIds[i];
      // iterationAspectShape is [id, sourceId, mode, id, sourceId, mode, ...]
      const sourceId = iterationAspectShape[i * 3 + 1];
      const mode = iterationAspectShape[i * 3 + 2] as "match" | "flip";
      const sourceAspect = sourceAspectById.get(sourceId) ?? "1:1";
      const aspectRatio =
        mode === "flip" ? flipAspectRatio(sourceAspect) : sourceAspect;
      out.push({ id, aspectRatio });
    }
    return out;
  }, [iterationIds, iterationAspectShape, sources]);

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
