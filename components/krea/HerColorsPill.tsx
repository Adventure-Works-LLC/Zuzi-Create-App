"use client";

/**
 * v5.6.2/v5.7 — the two Style Explore switches, shared across every
 * surface that fires style_explore runs (StylesPanel card-taps +
 * ExploreSheet batches + Lightbox "More like this"). State lives in
 * the canvas store so a flip anywhere is honored everywhere;
 * session-sticky, both default OFF.
 *
 * "Her colors": ON → keep-source-colors directive variant (sketch
 * keeps its palette, reference contributes texture/brushwork only).
 * "Loose": ON → subtractive loose directive variant (the preservation
 * clauses are deleted; the model may alter her drawing).
 * The flags compose into a 4-way directive select per engine family.
 */

import { useCanvas } from "@/stores/canvas";

function SwitchPill({
  label,
  pressed,
  onToggle,
  titleOn,
  titleOff,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  titleOn: string;
  titleOff: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      title={pressed ? titleOn : titleOff}
      className={[
        "inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5",
        "text-xs uppercase tracking-[0.18em] no-callout transition-colors",
        pressed
          ? "border-accent bg-accent/10 text-foreground"
          : "border-hairline bg-card text-text-mute hover:text-foreground",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "h-2 w-2 rounded-full transition-colors",
          pressed ? "bg-accent" : "bg-hairline",
        ].join(" ")}
      />
      {label}
    </button>
  );
}

export function HerColorsPill() {
  const keepHerColors = useCanvas((s) => s.keepHerColors);
  const setKeepHerColors = useCanvas((s) => s.setKeepHerColors);
  return (
    <SwitchPill
      label="Her colors"
      pressed={keepHerColors}
      onToggle={() => setKeepHerColors(!keepHerColors)}
      titleOn="Her colors ON — palette stays from her sketch; the style brings texture and brushwork only."
      titleOff="Her colors OFF — the style reference brings its colors AND its texture."
    />
  );
}

export function LoosePill() {
  const looseMode = useCanvas((s) => s.looseMode);
  const setLooseMode = useCanvas((s) => s.setLooseMode);
  return (
    <SwitchPill
      label="Loose"
      pressed={looseMode}
      onToggle={() => setLooseMode(!looseMode)}
      titleOn="Loose ON — the model may alter her drawing (the keep-exactly rules are lifted)."
      titleOff="Loose OFF — the drawing's character and shapes are preserved exactly."
    />
  );
}
