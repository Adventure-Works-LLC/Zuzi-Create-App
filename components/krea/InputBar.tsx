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
 *   presets          ['avery']             Avery is the always-on default (was
 *                                          'background' before the Avery v1 lock)
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
import {
  Camera,
  Image as ImageIcon,
  Loader2,
  Shuffle,
  Wand2,
  X,
} from "lucide-react";

import { HerColorsPill } from "./HerColorsPill";
import { useSources } from "@/hooks/useSources";
import { useIterations } from "@/hooks/useIterations";
import { useImageUrl } from "@/hooks/useImageUrl";
import { authFetch } from "@/lib/auth/authFetch";
import { TIMEOUT_JSON_MS, withTimeout } from "@/lib/fetchTimeout";
import { useCanvas } from "@/stores/canvas";
import { type Preset } from "@/lib/db/schema";
import { TILE_COUNT_MAX } from "@/lib/gemini/imagePrompts";
import { costFor, costForVary, pricePerImage, varyPricePerImage } from "@/lib/cost";
import {
  VARY_STRENGTHS,
  varyStrengthLabel,
  type VaryStrength,
} from "@/lib/fal/varyConstants";

const PRESET_LABEL: Record<Preset, string> = {
  color: "Color",
  ambiance: "Ambiance",
  lighting: "Lighting",
  background: "Background",
  avery: "Avery",
  etching: "Etching",
};

/**
 * UI-visible preset subset. Color AND Ambiance are intentionally
 * absent — see AGENTS.md §4 ("Color and Ambiance hidden from UI").
 * The full PRESETS array remains exported from `lib/db/schema.ts`,
 * all six prompt bodies (Color, Ambiance, Lighting, Background,
 * Avery, Etching) + their dominator-ladder routing in
 * `lib/gemini/imagePrompts.ts buildPrompt` remain in place, and the
 * build-time canaries in `scripts/check-prompts.ts` still validate
 * every locked body against drift. This subset only governs what
 * the InputBar's checkbox grid renders — neither Color nor Ambiance
 * found their reliable operation across many iteration cycles, so
 * we hide them from Zuzi while preserving every line of work for
 * future revisitation.
 *
 * Order: Avery (always-on default), then alphabetical (Etching,
 * Lighting, Background). Avery sits first so the cell the eye lands
 * on first is also the one that's pre-selected — the visual default
 * and the canonical default agree.
 */
const VISIBLE_PRESETS: ReadonlyArray<Preset> = [
  "avery",
  "etching",
  "lighting",
  "background",
];

/** Optional one-line subline rendered under the checkbox label. Ambiance,
 *  Background, Color, and Avery all carry sublines because their
 *  operations don't read literally from the label:
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
 *    - Avery (v1) is "in Milton Avery's voice" — names the painter
 *      reference directly so the cell label reads as "preset =
 *      surface/color treatment" rather than a vague abstraction. The
 *      label "Avery" alone could mean anything; the subline grounds it.
 *  Lighting reads literally so it gets no subline. Phrasing tracks the
 *  prompt framings in `lib/gemini/imagePrompts.ts`. */
const PRESET_SUBLINE: Partial<Record<Preset, string>> = {
  ambiance: "complete it in her voice",
  background: "develop her background ideas",
  color: "push her colors with confidence",
  avery: "in Milton Avery's voice",
  etching: "old-master shadow hatching",
};

/** v5 Sketch Vary strength picker copy. One line per strength — the
 *  labels come from varyStrengthLabel (subtle/medium/wild); these
 *  sublines say what each does in product language (AGENTS.md §16:
 *  settle/perfect → liberties in her vocabulary → free-range her
 *  world). Keyed by value, not index, so a future strength-set change
 *  fails loudly here instead of mislabeling. */
const VARY_SUBLINE: Record<VaryStrength, string> = {
  0.45: "settle it — same drawing, perfected",
  0.6: "small liberties, all her marks",
  0.75: "roam her world",
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

/**
 * v5.3: Pro daily fuel gauge. Google caps the Pro image model at N
 * requests per DAY (250 on the current tier — see AGENTS.md §4 quota
 * notes + /api/usage); before this gauge the wall was invisible until
 * runs started failing mid-session. Count is approximate (server
 * counts completed Pro tiles; retries aren't logged) hence the "~".
 * Refetches on mount and whenever `refreshKey` changes (the InputBar
 * passes a counter bumped after each generate settles).
 */
function ProQuotaGauge({ refreshKey }: { refreshKey: number }) {
  const [gauge, setGauge] = useState<{ count: number; limit: number } | null>(
    null,
  );
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const resp = await authFetch(
          "/api/usage",
          withTimeout({ signal: ac.signal }, TIMEOUT_JSON_MS),
        );
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          proToday?: { count?: number; limit?: number };
        };
        if (
          typeof data.proToday?.count === "number" &&
          typeof data.proToday?.limit === "number"
        ) {
          setGauge({ count: data.proToday.count, limit: data.proToday.limit });
        }
      } catch {
        // gauge is decorative — stay silent on failure
      }
    })();
    return () => ac.abort();
  }, [refreshKey]);

  if (!gauge) return null;
  const nearCap = gauge.count >= gauge.limit * 0.8;
  const atCap = gauge.count >= gauge.limit;
  return (
    <span
      className={[
        "text-xs tabular-nums",
        atCap
          ? "text-destructive"
          : nearCap
            ? "text-amber-500"
            : "text-text-mute",
      ].join(" ")}
      title="Google allows a fixed number of Pro-model images per day; resets overnight. Flash and Vary don't count against it."
    >
      Pro today ~{gauge.count}/{gauge.limit}
    </span>
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
  // v2.2: Style Explore entry. Library count gates the Explore button's
  // enabled state (empty library → disabled with hint subline → tap still
  // opens the sheet to its empty-state CTA per the plan, but for v2.2's
  // Idle-state ship we just disable the button + render the hint, which
  // also discourages an empty-state-only flow we don't have yet).
  const stylePaintingsCount = useCanvas((s) => s.stylePaintings.length);
  const setExploreSheetOpen = useCanvas((s) => s.setExploreSheetOpen);

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
   * (canonical default ['avery']); this flag toggles a visual "all
   * visible cells unselected" state without modifying the store.
   * Resolved by either picking a cell (→ setPreset(p)) or clicking
   * outside the cells container (→ setPreset('avery')). Both paths
   * set pickerOpen back to false.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** v5 Sketch Vary strength popover (Subtle/Medium/Wild). UI-local,
   *  same lifecycle pattern as pickerOpen — outside-click dismisses via
   *  the document pointerdown listener below. */
  const [varyOpen, setVaryOpen] = useState(false);
  const varyRef = useRef<HTMLDivElement>(null);
  /** v5.3: bumped every time a generate settles so the Pro gauge
   *  refetches — the count only moves when runs complete. */
  const [quotaRefresh, setQuotaRefresh] = useState(0);
  useEffect(() => {
    if (!generating) setQuotaRefresh((k) => k + 1);
  }, [generating]);

  // Mutually-exclusive UI: derive a single selection from the store's
  // presets array. The canonical default is ['avery'] (never empty),
  // so `selectedPreset` is normally always a Preset. The `?? null`
  // fallback covers the transient edge case where legacy data or a
  // future bug produces an empty array — the picker treats that the
  // same as transitional (all visible) and the dismiss path snaps
  // back to Avery, restoring the invariant.
  const selectedPreset: Preset | null =
    (presets[0] as Preset | undefined) ?? null;
  /** True when the store's selection corresponds to one of the
   *  cells the picker actually renders. False when the store holds
   *  null OR a hidden preset (currently 'color' or 'ambiance' —
   *  see VISIBLE_PRESETS). The hidden-preset case is defensive: the
   *  UI no longer sets either, but a future re-enable, a stale
   *  store hand-off, or a smoke-script-driven dev session could
   *  still land one in the store, and we want the picker to look
   *  legitimately empty (not stuck-with-no-checked-cell) so the
   *  outside-click snap-back can restore Background. */
  const isSelectedVisible =
    selectedPreset !== null && VISIBLE_PRESETS.includes(selectedPreset);
  /** True when the picker should render in its "all visible,
   *  none checked" transitional state. Either user tapped ×
   *  (pickerOpen), the store has no selection, OR the store's
   *  selection is a hidden preset (defensive). Drives both the
   *  cell visibility logic AND the Generate-disabled gate. */
  const showPicker = pickerOpen || !isSelectedVisible;

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
      // Outside click → snap Avery back + close picker. Always Avery,
      // never the previously-selected preset, per spec: dismissal
      // restores the always-on default rather than the user's last
      // selection (which they explicitly tapped × on).
      setPreset("avery");
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [showPicker, setPreset]);

  // Outside-click dismiss for the Vary strength popover. Same
  // pointerdown rationale as the preset picker's listener above.
  useEffect(() => {
    if (!varyOpen) return;
    const onOutside = (e: PointerEvent) => {
      const wrap = varyRef.current;
      if (!wrap) return;
      if (wrap.contains(e.target as Node)) return;
      setVaryOpen(false);
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [varyOpen]);

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
    if (showPicker) {
      // Picker-open snap-back. The user opened the picker (× on a checked
      // cell) and tapped Generate without committing to a new preset; per
      // spec, the Generate tap counts as an outside-click → restore Avery
      // as the canonical default and close the picker. NO generation
      // fires this tap; the user can tap Generate again now that Avery
      // is selected to actually fire.
      //
      // Why this guard exists in addition to the document-level pointerdown
      // listener: HTML `disabled` historically blocked pointerdown delivery
      // on iPad Safari, defeating the outside-click dismiss path. The
      // button now stays HTML-enabled during the transitional state and
      // routes the click here instead. Doubled with the listener — both
      // paths are idempotent.
      setPreset("avery");
      setPickerOpen(false);
      return;
    }
    setGenerateError(null);
    try {
      const result = await generate();
      if (!result) {
        // hook surfaced an error via the optimistic placeholder; still mirror it
        // for the inline error message.
        setGenerateError("Couldn’t start generation. Try again.");
      }
    } catch (e) {
      // v4.6: generate() rethrows the monthly-cap rejection so cap-aware
      // surfaces (ExploreSheet) can parse it; here the message itself is
      // the right inline error ("Monthly cap reached: $X / $Y").
      setGenerateError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Fire a sketch_vary run at the tapped strength. Vary ignores the
   *  preset picker entirely (the LoRA owns its locked prompt), so no
   *  showPicker guard — tapping Vary while the picker is transitional
   *  lets the document listener snap Avery back on the same gesture,
   *  which is fine: presets don't participate in vary. */
  const onVary = async (strength: VaryStrength) => {
    setVaryOpen(false);
    setGenerateError(null);
    try {
      const result = await generate({
        mode: "sketch_vary",
        varyStrength: strength,
      });
      if (!result) {
        setGenerateError("Couldn’t start Vary. Try again.");
      }
    } catch (e) {
      // Monthly-cap rejection rethrows with the user-facing message.
      setGenerateError(e instanceof Error ? e.message : String(e));
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
            Renders the VISIBLE_PRESETS subset (currently 4: avery,
            etching, lighting, background — Color and Ambiance are
            hidden, see the constant's doc above). Grid is
            `grid-cols-2 sm:grid-cols-4` — phones (< 640px) get a 2×2
            stack so cells stay tappable; iPad portrait (744+) and up
            get one tidy row of four. Default state (showPicker=false):
            one cell selected and visible with `×` cancel; the other
            three transition to opacity-0 + translateY-2 over 150ms
            but stay in their grid columns so the selected one's
            position doesn't shift. Transitional state
            (showPicker=true): all four cells visible and unchecked.
            Picking a cell → that becomes selected, transitional ends.
            Outside-click → Avery snaps back, transitional ends
            (handled by the document listener above). Renders only
            when a source exists. */}
        {!isEmpty && (
          <div ref={presetCellsRef} className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {VISIBLE_PRESETS.map((p) => (
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
              {/* v5.4 (AGENTS.md §17): the pill is the ENGINE picker.
                  Flash/Pro = Gemini (count against the Pro daily gauge
                  when Pro); Max = FLUX 2 Max and Seedream = Seedream
                  5-Lite, both on fal — same-price painterly alternate
                  and the 4×-cheaper explorer, both immune to Google's
                  daily cap. Validated July 2026 against her favorited
                  pairs; Pro remains the default. */}
              <PillToggle
                value={modelTier}
                options={[
                  { value: "flash", label: "Flash" },
                  { value: "pro", label: "Pro" },
                  { value: "flux2max", label: "Max" },
                  { value: "seedream", label: "Seedream" },
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
              {/* v5.6.2: "Her colors" — global switch for the style
                  runs (Explore card-taps + batches + More-like-this).
                  Lives here per Jeff so it's set alongside the other
                  dials before opening any panel, same pattern as the
                  tier toggle. */}
              <HerColorsPill />
              <CountStepper count={count} setCount={setCount} />
              <span className="text-xs text-text-mute tabular-nums">
                ${projectedCost.toFixed(2)}{" "}
                <span className="text-text-mute/60">
                  (${pricePerImage(modelTier, resolution).toFixed(3)} × {count})
                </span>
              </span>
              <ProQuotaGauge refreshKey={quotaRefresh} />
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
              <>
                {/* Explore styles → opens the ExploreSheet modal overlay.
                    Visible whenever sources exist; disabled with a hint
                    subline when the style library is empty. We don't gate
                    on `generating` because Explore is its own work-stream
                    (the sheet manages its own batch firing) — but we DO
                    disable during a source-upload to avoid racing the
                    SourceStrip's optimistic state with the sheet's
                    sourceId-bound flow. */}
                <div className="flex flex-col items-end gap-0.5">
                  <button
                    type="button"
                    onClick={() => setExploreSheetOpen(true)}
                    disabled={stylePaintingsCount === 0 || uploading}
                    aria-label="Explore styles"
                    className={[
                      "inline-flex items-center gap-2 rounded-full",
                      "px-4 py-2 text-sm font-medium no-callout",
                      "border border-hairline bg-card",
                      "text-foreground/90 hover:bg-secondary",
                      "transition-opacity",
                      stylePaintingsCount === 0 || uploading
                        ? "opacity-60 cursor-not-allowed"
                        : "hover:opacity-100",
                    ].join(" ")}
                  >
                    <Wand2 className="h-4 w-4" strokeWidth={1.5} />
                    Explore styles
                    <span className="text-text-mute" aria-hidden>
                      →
                    </span>
                  </button>
                  {stylePaintingsCount === 0 && (
                    // Hint subline. Rendering it underneath the button keeps
                    // the row's height stable while still telegraphing the
                    // path forward ("add some styles to enable this").
                    <span className="caption-display text-[10px] uppercase tracking-[0.18em] text-text-mute">
                      Add styles first
                    </span>
                  )}
                </div>
                {/* v5 Sketch Vary — redraw the source in her own hand via
                    the ZUZQ LoRA (AGENTS.md §16). Tap opens a 3-strength
                    picker; picking fires immediately. Runs against the
                    CURRENT SOURCE (not a tile): the loop is vary →
                    favorite a keeper → Use as source → generate. */}
                <div ref={varyRef} className="relative">
                  {varyOpen && (
                    <div
                      role="menu"
                      aria-label="Vary strength"
                      className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-hairline bg-card p-1.5 shadow-lg"
                    >
                      <p className="caption-display px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-text-mute">
                        Redraw in her hand
                      </p>
                      {VARY_STRENGTHS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="menuitem"
                          onClick={() => void onVary(s)}
                          className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary no-callout"
                        >
                          <span className="text-sm capitalize text-foreground">
                            {varyStrengthLabel(s)}
                          </span>
                          <span className="text-[11px] text-text-mute">
                            {VARY_SUBLINE[s]}
                          </span>
                        </button>
                      ))}
                      <p className="border-t border-hairline/60 mt-1 px-2.5 pt-1.5 pb-1 text-[11px] tabular-nums text-text-mute">
                        {count} × ${varyPricePerImage().toFixed(3)} = $
                        {costForVary(count).toFixed(2)}
                      </p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setVaryOpen((v) => !v)}
                    disabled={generating || uploading}
                    aria-haspopup="menu"
                    aria-expanded={varyOpen}
                    className={[
                      "inline-flex items-center gap-2 rounded-full",
                      "px-4 py-2 text-sm font-medium no-callout",
                      "border border-hairline bg-card",
                      "text-foreground/90 hover:bg-secondary",
                      "transition-opacity",
                      generating || uploading
                        ? "opacity-60 cursor-not-allowed"
                        : "hover:opacity-100",
                    ].join(" ")}
                  >
                    <Shuffle className="h-4 w-4" strokeWidth={1.5} />
                    Vary
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void onGenerate()}
                  // NOTE: deliberately HTML-enabled during showPicker — only
                  // disabled when the work pipe is actually busy. Disabling
                  // the HTML element during the transitional state blocks
                  // pointerdown delivery on iPad Safari, so the document-
                  // level outside-click dismiss path can't see the tap and
                  // the user lands in a dead zone. With the button live,
                  // `onGenerate` snaps Background back + closes the picker
                  // (no generation fires) — see the guard at the top of
                  // onGenerate. Visually still dimmed via opacity-70 to
                  // signal "not the canonical Generate state right now."
                  disabled={generating || uploading}
                  className={[
                    "inline-flex items-center gap-2 rounded-full",
                    "px-5 py-2 text-sm font-medium no-callout",
                    "bg-accent text-accent-foreground",
                    "transition-opacity",
                    generating || uploading
                      ? "opacity-60 cursor-wait"
                      : showPicker
                        ? "opacity-70 hover:opacity-80"
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
              </>
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
