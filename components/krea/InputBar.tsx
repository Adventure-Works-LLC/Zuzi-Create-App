"use client";

/**
 * InputBar — sticky-bottom composer.
 *
 * Two modes:
 *   1. Empty-state (no source yet): three primary input affordances —
 *      Take photo / Choose / drag+drop+paste — and nothing else. Above it
 *      the page renders a one-line italic cue.
 *   2. Populated (a current source is set): the full configurator —
 *      4 preset checkboxes (Color/Composition/Lighting/Background)
 *      + Flash|Pro pill + 1K|4K pill + count stepper + Generate button
 *      with live cost annotation. The current source's thumbnail sits to the
 *      left as a small preview.
 *
 * Drop + paste also work in both modes — the drop zone is the whole page so
 * paint can land anywhere. The InputBar just renders the explicit buttons.
 *
 * The bar is `position: sticky; bottom: 0` so it floats above the tile
 * stream. Padding respects `env(safe-area-inset-bottom)` for iPad PWA.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Image as ImageIcon, Loader2 } from "lucide-react";

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

/** Optional one-line subline rendered under the checkbox label. Ambiance and
 *  Background both have sublines because their operations don't read
 *  literally from the label — Ambiance is "continue in her voice" (not just
 *  add atmosphere), and Background is "different setting in HER hand" (not
 *  Pro's default rendered AI illustration). Color and Lighting read
 *  literally so they get no subline. Phrasing tracks the v8/v3 prompt
 *  framings in `lib/gemini/imagePrompts.ts`. */
const PRESET_SUBLINE: Partial<Record<Preset, string>> = {
  ambiance: "complete it in her voice",
  background: "different setting, in her hand",
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

function PresetCheckbox({
  preset,
  checked,
  onToggle,
}: {
  preset: Preset;
  checked: boolean;
  onToggle: () => void;
}) {
  const subline = PRESET_SUBLINE[preset];
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={[
        "flex items-center gap-2 px-3 py-2 rounded-md",
        "border text-sm text-left",
        "transition-colors no-callout",
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
      <span className="flex flex-col leading-tight">
        <span>{PRESET_LABEL[preset]}</span>
        {subline && (
          <span className="text-[11px] text-text-mute/80">{subline}</span>
        )}
      </span>
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
  const togglePreset = useCanvas((s) => s.togglePreset);
  const count = useCanvas((s) => s.count);
  const setCount = useCanvas((s) => s.setCount);

  const { uploadFile, uploading } = useSources();
  const { generate, generating } = useIterations();

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

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

        {/* Top row — preset checkboxes (only when a source exists). */}
        {!isEmpty && (
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <PresetCheckbox
                key={p}
                preset={p}
                checked={presets.includes(p)}
                onToggle={() => togglePreset(p)}
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
                disabled={generating || uploading}
                className={[
                  "inline-flex items-center gap-2 rounded-full",
                  "px-5 py-2 text-sm font-medium no-callout",
                  "bg-accent text-accent-foreground",
                  "transition-opacity",
                  generating || uploading
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
