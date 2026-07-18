"use client";

/**
 * v5.6.2 — the "Her colors" switch, shared across every surface that
 * fires style_explore runs (StylesPanel card-taps + ExploreSheet
 * batches). State lives in the canvas store so a flip in one surface
 * is honored by the other; session-sticky, defaults OFF.
 *
 * ON  → keep-source-colors directive variant: the sketch keeps its
 *       palette, the reference contributes texture/brushwork only.
 * OFF → the original locked directive (reference brings color AND
 *       texture) — byte-identical to pre-v5.6 behavior.
 */

import { useCanvas } from "@/stores/canvas";

export function HerColorsPill() {
  const keepHerColors = useCanvas((s) => s.keepHerColors);
  const setKeepHerColors = useCanvas((s) => s.setKeepHerColors);
  return (
    <button
      type="button"
      onClick={() => setKeepHerColors(!keepHerColors)}
      aria-pressed={keepHerColors}
      title={
        keepHerColors
          ? "Her colors ON — palette stays from her sketch; the style brings texture and brushwork only."
          : "Her colors OFF — the style reference brings its colors AND its texture."
      }
      className={[
        "inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5",
        "text-xs uppercase tracking-[0.18em] no-callout transition-colors",
        keepHerColors
          ? "border-accent bg-accent/10 text-foreground"
          : "border-hairline bg-card text-text-mute hover:text-foreground",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "h-2 w-2 rounded-full transition-colors",
          keepHerColors ? "bg-accent" : "bg-hairline",
        ].join(" ")}
      />
      Her colors
    </button>
  );
}
