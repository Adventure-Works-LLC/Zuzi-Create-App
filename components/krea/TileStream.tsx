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
 */

import { useEffect, useRef } from "react";

import { IterationRow } from "./IterationRow";
import { useStreamingResults } from "@/hooks/useStreamingResults";
import { useCanvas } from "@/stores/canvas";

export function TileStream() {
  useStreamingResults();
  const iterations = useCanvas((s) => s.iterations);
  const newestId = iterations[0]?.id;
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

  if (iterations.length === 0) return null;

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
        {iterations.map((it) => (
          <IterationRow key={it.id} iteration={it} />
        ))}
      </div>
    </div>
  );
}
