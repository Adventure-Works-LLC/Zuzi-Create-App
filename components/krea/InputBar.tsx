"use client";

/**
 * InputBar — sticky-bottom composer.
 *
 * Two modes:
 *   1. Empty-state (no source yet): three primary input affordances —
 *      Take photo / Choose / drag+drop+paste — and nothing else. Above it
 *      the page renders a one-line italic cue.
 *   2. Populated (a current source is set): the full configurator —
 *      mutually-exclusive preset picker (Color/Ambiance/Lighting/Background,
 *      exactly one always selected) + Flash|Pro pill + Match|Flip aspect
 *      pill + 1K|4K pill + count stepper + Generate button with live cost
 *      annotation. The current source's thumbnail sits to the left as a
 *      small preview.
 *
 * ## Canonical input defaults
 *
 * Restored on page load AND on context shifts (upload, source switch).
 * Never persisted across sessions — the canvas store is in-memory only;
 * any future localStorage/cookie persistence on these would require an
 * explicit user request (don't drift them by accident).
 *
 *   modelTier        'pro'                 better quality, what Zuzi works in
 *   resolution       '1k'                  cheaper / faster — 4K is opt-in
 *   aspectRatioMode  'match'               preserve source aspect — flip is opt-in
 *   count            TILE_COUNT_DEFAULT    3 — fits the layout cleanly
 *   presets          ['background']        Background is the always-on default
 *
 * `modelTier`, `resolution`, and `count` are sticky within a session
 * (deliberately — they reflect the user's working-tier preference, not
 * painting-specific state). `aspectRatioMode` and `presets` reset on any
 * context shift (upload, source switch) to give each painting a clean
 * starting point.
 *
 * ## Mutually-exclusive preset picker (transitional state)
 *
 * Exactly one preset is always canonically selected — the store never
 * holds an empty `presets` array. Picker UX:
 *
 *   - Default: selected preset visible + `×` cancel affordance; the
 *     other three are hidden (opacity 0 + translateY -8px,
 *     pointer-events still alive for atomic-swap radio behavior).
 *   - Tap × → enters TRANSITIONAL state: all four cells visible and
 *     unchecked. Generate is disabled. The store is unchanged — the
 *     previously selected preset is still in `presets[0]`. The
 *     transitional state is purely a UI affordance.
 *   - Pick a cell while transitional → that becomes the selected one,
 *     transitional state ends.
 *   - Click anywhere outside the cells (Flash|Pro toggle, source strip,
 *     iteration stream, disabled Generate, etc.) while transitional →
 *     Background snaps back as the selection, transitional state ends.
 *     This enforces the "always-one-selected" invariant: the user can
 *     never persistently land in a no-selection state.
 *
 * `buildPrompt`'s empty-presets branch stays in code as a defensive
 * fallback for legacy iteration rows + smoke testing flexibility, but
 * the UI never sends an empty array to /api/iterate.
 *
 * ## Other UI details
 *
 * Drop + paste also work in both modes — the drop zone is the whole page so
 * paint can land anywhere. The InputBar just renders the explicit buttons.
 *
 * The bar is `position: sticky; bottom: 0` so it floats above the tile
 * stream. Padding respects `env(safe-area-inset-bottom)` for iPad PWA.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Image as ImageIcon, Loader2, X } from "lucide-react";

import { useSources } from "@/hooks/useSources";
import { useIterations } from "@/hooks/useIterations";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas } from "@/stores/canvas";
import { PRESETS, type Preset } from "@/lib/db/schema";
import { TILE_COUNT_MAX } from "@/lib/gemini/imagePrompts";
import { costFor, pricePerImage } from "@/lib/cost";

const PRESET_LABEL: Record<Preset, string> = {
  color: "Color",
  ambiance: "Ambiance",
  lighting: "Lighting",
  background: "Background",
};

/** Optional one-line subline rendered under the checkbox label. Ambiance,
 *  Background, and Color all carry sublines because their operations don't
 *  read literally from the label:
 *    - Ambiance is "continue in her voice" (not just add atmosphere).
 *    - Background (v5) is "develop her background ideas" — Pro reads the
 *      source's compositional intent (interior/outdoor, framing, motifs,
 *      rhythm) and DEVELOPS it rather than swapping the setting.
 *      Phrasing deliberately avoids "swap" / "replace" / "different
 *      setting" since v5 explicitly does not do those things.
 *    - Color (v4) is now "push her colors with confidence" — Pro
 *      channels an active painterly posture (the artist on her second
 *      pass with confidence and joy) rather than executing a passive
 *      technical refinement. Phrasing deliberately avoids timid words
 *      like "tune" / "refine" / "enrich" — those describe the v3
 *      framing that produced lifeless lateral shifts. "Push" is the
 *      load-bearing verb v4 was built around.
 *  Lighting reads literally so it gets no subline. Phrasing tracks the
 *  v8/v5/v4 prompt framings in `lib/gemini/imagePrompts.ts`. */
const PRESET_SUBLINE: Partial<Record<Preset, string>> = {
  ambiance: "complete it in her voice",
  background: "develop her background ideas",
  color: "push her colors with confidence",
};

function PillToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex h-9 rounded-full bg-secondary p-1"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            "h-7 px-3 rounded-full text-xs font-medium",
            "transition-colors no-callout",
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-text-mute hover:text-foreground",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One preset cell in the mutually-exclusive picker grid.
 *
 * Visibility states:
 *   - `selectedPreset === null`: ALL cells render normally; tap any to
 *     select. (`hidden` prop is false on every cell.)
 *   - `selectedPreset === <this>`: this cell renders checked + shows a
 *     small `×` affordance; tapping the cell OR the `×` deselects.
 *   - `selectedPreset === <other>`: this cell is `hidden` — opacity 0,
 *     translateY -8px, pointer-events disabled, aria-hidden. The cell
 *     remains in the grid so the selected one's column position is
 *     preserved (no layout jump). Animation: 150ms ease-out.
 *
 * The `×` is a discoverable cancel affordance per Zuzi's spec. Tapping
 * the rest of the checked cell ALSO deselects (default toggle), but the
 * `×` is the explicit visual cue that the selection is dismissable.
 */
function PresetCheckbox({
  preset,
  checked,
  hidden,
  onSelect,
  onCancel,
}: {
  preset: Preset;
  /** `true` if this preset is the currently-selected one. */
  checked: boolean;
  /** `true` if a DIFFERENT preset is selected (this cell should fade out). */
  hidden: boolean;
  /** Called when the cell is tapped while not checked — selects this preset. */
  onSelect: () => void;
  /** Called when the cell is tapped while checked OR the `×` is tapped —
   *  clears the selection back to none. */
  onCancel: () => void;
}) {
  const subline = PRESET_SUBLINE[preset];
  const onCellClick = () => {
    if (checked) onCancel();
    else onSelect();
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-hidden={hidden ? true : undefined}
      tabIndex={hidden ? -1 : 0}
      onClick={onCellClick}
      className={[
        "relative flex w-full items-center gap-2 px-3 py-2 rounded-md",
        "border text-sm text-left",
        "transition-[opacity,transform,colors,border-color,background-color] duration-150 ease-out",
        // Visibility: opacity + transform animate. Hidden cells stay
        // tappable so a tap during the fade-out window atomically swaps
        // the selection (radio-button semantics: tap any cell, even
        // mid-animation, to switch). The 150ms fade window is short
        // enough that the mid-fade tappable surface doesn't cause real
        // confusion. (We deliberately do NOT add `pointer-events-none`
        // here — that would force a two-tap dance to switch presets.)
        hidden
          ? "opacity-0 -translate-y-2"
          : "opacity-100 translate-y-0",
        checked
          ? "border-accent bg-accent/10 text-foreground"
          : "border-hairline/60 text-text-mute hover:text-foreground hover:border-hairline",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
          checked
            ? "border-accent bg-accent text-accent-foreground"
            : "border-hairline/80",
        ].join(" ")}
        aria-hidden
      >
        {checked && (
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="2.5 6.5 5 9 9.5 3.5" />
          </svg>
        )}
      </span>
      <span className="flex flex-1 flex-col leading-tight min-w-0">
        <span className="truncate">{PRESET_LABEL[preset]}</span>
        {subline && (
          <span className="text-[11px] text-text-mute/80 truncate">
            {subline}
          </span>
        )}
      </span>
      {checked && (
        // `<span role="button">` (not nested <button>) for the same reason
        // Tile.tsx's favorite-star + menu-trigger use the pattern: nested
        // <button> in HTML is invalid, role="button" with manual click +
        // keyboard handlers preserves a11y. e.stopPropagation prevents
        // the outer cell's onClick from also firing (would still
        // deselect, just doubled).
        <span
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onCancel();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={`Clear ${PRESET_LABEL[preset]} selection`}
          className={[
            "ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "text-text-mute hover:text-foreground hover:bg-background/60",
            "transition-colors no-callout",
          ].join(" ")}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      )}
    </button>
  );
}

function CountStepper({
  count,
  setCount,
}: {
  count: number;
  setCount: (n: number) => void;
}) {
  return (
    <div className="inline-flex h-9 items-center rounded-full bg-secondary px-1">
      <button
        type="button"
        onClick={() => setCount(Math.max(1, count - 1))}
        disabled={count <= 1}
        className="h-7 w-7 rounded-full text-text-mute hover:text-foreground disabled:opacity-40 no-callout"
        aria-label="Decrease tile count"
      >
        −
      </button>
      <span className="px-2 text-sm tabular-nums text-foreground/90 min-w-[1.5rem] text-center">
        {count}
      </span>
      <button
        type="button"
        onClick={() => setCount(Math.min(TILE_COUNT_MAX, count + 1))}
        disabled={count >= TILE_COUNT_MAX}
        className="h-7 w-7 rounded-full text-text-mute hover:text-foreground disabled:opacity-40 no-callout"
        aria-label="Increase tile count"
      >
        +
      </button>
    </div>
  );
}

function CurrentSourceThumb() {
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const current = sources.find((s) => s.sourceId === currentSourceId) ?? null;
  const { url } = useImageUrl(current?.inputKey ?? null);
  if (!current) return null;
  return (
    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md ring-1 ring-hairline">
      {url ? (
        <img src={url} alt="Source" className="h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bloom-warm" aria-hidden />
      )}
    </div>
  );
}

export function InputBar() {
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const modelTier = useCanvas((s) => s.modelTier);
  const setModelTier = useCanvas((s) => s.setModelTier);
  const resolution = useCanvas((s) => s.resolution);
  const setResolution = useCanvas((s) => s.setResolution);
  const presets = useCanvas((s) => s.presets);
  const setPreset = useCanvas((s) => s.setPreset);
  const aspectRatioMode = useCanvas((s) => s.aspectRatioMode);
  const setAspectRatioMode = useCanvas((s) => s.setAspectRatioMode);
  const count = useCanvas((s) => s.count);
  const setCount = useCanvas((s) => s.setCount);

  const { uploadFile, uploading } = useSources();
  const { generate, generating } = useIterations();

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  /** Wraps the four preset cells. Used by the picker-open dismiss
   *  listener to detect outside-clicks: any pointerdown whose target
   *  isn't a descendant of this element snaps back to Background and
   *  closes the picker. Includes the cells AND the `×` cancel
   *  affordance inside the selected cell, both of which should NOT
   *  trigger dismissal. */
  const presetCellsRef = useRef<HTMLDivElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  /**
   * Picker-open transitional state — see the docstring at top of file.
   * UI-local: the canvas store always holds a non-empty `presets` array
   * (canonical default ['background']); this flag toggles a visual
   * "all four cells unselected" state without modifying the store.
   * Resolved by either picking a cell (→ setPreset(p)) or clicking
   * outside the cells container (→ setPreset('background')). Both
   * paths set pickerOpen back to false.
   */
  const [pickerOpen, setPickerOpen] = useState(false);

  // Mutually-exclusive UI: derive a single selection from the store's
  // presets array. The canonical default is ['background'] (never
  // empty), so `selectedPreset` is normally always a Preset. The
  // `?? null` fallback covers the transient edge case where legacy
  // data or a future bug produces an empty array — the picker treats
  // that the same as transitional (all four visible) and the dismiss
  // path snaps back to Background, restoring the invariant.
  const selectedPreset: Preset | null =
    (presets[0] as Preset | undefined) ?? null;
  /** True when the picker should render in its "all four visible,
   *  none checked" transitional state. Either user tapped × (pickerOpen)
   *  or the store somehow has no selection (selectedPreset === null —
   *  defensive). Drives both the cell visibility logic AND the
   *  Generate-disabled gate. */
  const showPicker = pickerOpen || selectedPreset === null;

  // Outside-click dismiss while picker is open. pointerdown (not click)
  // so the dismiss + the underlying control's click both happen on the
  // same gesture — e.g., tapping the Flash|Pro pill while transitional
  // both snaps Background back AND toggles tier in one tap. The
  // listener is gated on `showPicker` so it only attaches during the
  // transitional state; cleanup runs as soon as a pick or outside-tap
  // resolves it.
  useEffect(() => {
    if (!showPicker) return;
    const onOutside = (e: PointerEvent) => {
      const cells = presetCellsRef.current;
      if (!cells) return;
      if (cells.contains(e.target as Node)) return;
      // Outside click → snap Background back + close picker. Always
      // Background, never the previously-selected preset, per spec:
      // dismissal restores the always-on default rather than the user's
      // last selection (which they explicitly tapped × on).
      setPreset("background");
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [showPicker, setPreset]);

  // Publish the bar's actual rendered height (including padding + safe-area-
  // inset on PWA) as a CSS custom property so the tile stream / empty-canvas
  // can pad correctly. Without this, the hard-coded pb-[280px] occludes the
  // last tile when the bar wraps (preset row + bottom row + errors row all
  // stacking). offsetHeight gives border-box pixels, which is what the
  // consumer wants — the entire occluded region.
  useEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--inputbar-h", `${el.offsetHeight}px`);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => publish());
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--inputbar-h");
    };
  }, []);

  // Document-level paste — works regardless of focus, lands on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void uploadFile(file).catch((err) =>
              setUploadError(err instanceof Error ? err.message : String(err)),
            );
            return;
          }
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [uploadFile]);

  // Document-level drop. Listening on the body simplifies "drop anywhere".
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFile = Array.from(e.dataTransfer.types || []).includes("Files");
      if (hasFile) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void uploadFile(file).catch((err) =>
        setUploadError(err instanceof Error ? err.message : String(err)),
      );
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [uploadFile]);

  const projectedCost = useMemo(
    () => costFor(modelTier, resolution, count),
    [modelTier, resolution, count],
  );

  const onGenerate = async () => {
    setGenerateError(null);
    const result = await generate();
    if (!result) {
      // hook surfaced an error via the optimistic placeholder; still mirror it
      // for the inline error message.
      setGenerateError("Couldn’t start generation. Try again.");
    }
  };

  const onPickFile = (file: File | undefined) => {
    if (!file) return;
    void uploadFile(file).catch((err) =>
      setUploadError(err instanceof Error ? err.message : String(err)),
    );
  };

  const isEmpty = sources.length === 0 || !currentSourceId;

  return (
    <footer
      ref={footerRef}
      className={[
        "sticky bottom-0 z-30",
        "bg-background/90 backdrop-blur-md",
        "border-t border-hairline/60",
        "px-4 sm:px-6 pt-4",
      ].join(" ")}
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
    >
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
        {/* Errors row, transient. */}
        {(uploadError || generateError) && (
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-destructive">
              {uploadError ?? generateError}
            </p>
            <button
              type="button"
              onClick={() => {
                setUploadError(null);
                setGenerateError(null);
              }}
              className="text-xs uppercase tracking-[0.18em] text-text-mute hover:text-foreground no-callout"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Top row — mutually-exclusive preset picker.
            All four cells live in a fixed grid (2 cols on phone, 4 on
            tablet+). Default state (showPicker=false): one cell selected
            and visible with `×` cancel; the other three transition to
            opacity-0 + translateY-2 over 150ms but stay in their grid
            columns so the selected one's position doesn't shift.
            Transitional state (showPicker=true): all four cells visible
            and unchecked. Picking a cell → that becomes selected,
            transitional ends. Outside-click → Background snaps back,
            transitional ends (handled by the document listener above).
            Renders only when a source exists. */}
        {!isEmpty && (
          <div ref={presetCellsRef} className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PRESETS.map((p) => (
              <PresetCheckbox
                key={p}
                preset={p}
                checked={selectedPreset === p && !showPicker}
                hidden={!showPicker && selectedPreset !== p}
                onSelect={() => {
                  setPreset(p);
                  if (pickerOpen) setPickerOpen(false);
                }}
                onCancel={() => setPickerOpen(true)}
              />
            ))}
          </div>
        )}

        {/* Bottom row — source thumb + tier/resolution + count + Generate. */}
        <div className="flex flex-wrap items-center gap-3">
          {!isEmpty && <CurrentSourceThumb />}

          {!isEmpty && (
            <>
              <PillToggle
                value={modelTier}
                options={[
                  { value: "flash", label: "Flash" },
                  { value: "pro", label: "Pro" },
                ]}
                onChange={setModelTier}
                ariaLabel="Model tier"
              />
              <PillToggle
                value={resolution}
                options={[
                  { value: "1k", label: "1K" },
                  { value: "4k", label: "4K" },
                ]}
                onChange={setResolution}
                ariaLabel="Resolution"
              />
              {/* Aspect-ratio mode. Default 'match' = source aspect (preserves
                  the historical AGENTS.md §3 invariant). 'flip' swaps W:H so
                  portrait sources generate landscape outputs and vice versa
                  (1:1 stays 1:1). Self-documenting via the labels — Zuzi
                  discovers what it does by trying it. */}
              <PillToggle
                value={aspectRatioMode}
                options={[
                  { value: "match", label: "Match" },
                  { value: "flip", label: "Flip" },
                ]}
                onChange={setAspectRatioMode}
                ariaLabel="Aspect"
              />
              <CountStepper count={count} setCount={setCount} />
              <span className="text-xs text-text-mute tabular-nums">
                ${projectedCost.toFixed(2)}{" "}
                <span className="text-text-mute/60">
                  (${pricePerImage(modelTier, resolution).toFixed(3)} × {count})
                </span>
              </span>
            </>
          )}

          {/* Right-aligned action cluster */}
          <div className="ml-auto flex items-center gap-2">
            {isEmpty ? (
              <>
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-full border border-hairline px-4 py-2 text-sm text-foreground/90 hover:bg-secondary transition-colors no-callout"
                >
                  <Camera className="h-4 w-4" strokeWidth={1.5} />
                  Take photo
                </button>
                <button
                  type="button"
                  onClick={() => libraryInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-full border border-hairline px-4 py-2 text-sm text-foreground/90 hover:bg-secondary transition-colors no-callout"
                >
                  <ImageIcon className="h-4 w-4" strokeWidth={1.5} />
                  Choose
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void onGenerate()}
                // Disabled during the picker-open transitional state too —
                // the user must commit to a preset (pick one OR click
                // outside to snap back to Background) before Generate
                // fires. The document-level pointerdown listener handles
                // the click-outside-to-Background dismissal even when this
                // disabled button is the click target.
                disabled={generating || uploading || showPicker}
                className={[
                  "inline-flex items-center gap-2 rounded-full",
                  "px-5 py-2 text-sm font-medium no-callout",
                  "bg-accent text-accent-foreground",
                  "transition-opacity",
                  generating || uploading || showPicker
                    ? "opacity-60 cursor-wait"
                    : "hover:opacity-90",
                ].join(" ")}
              >
                {generating ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      strokeWidth={1.75}
                    />
                    Painting…
                  </>
                ) : (
                  "Generate"
                )}
              </button>
            )}
          </div>
        </div>

        {/* Hidden file inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            onPickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          ref={libraryInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            onPickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
    </footer>
  );
}
