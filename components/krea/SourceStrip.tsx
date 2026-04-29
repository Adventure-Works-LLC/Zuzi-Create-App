"use client";

/**
 * SourceStrip — sticky-top horizontal scroller of active sources, plus a
 * trailing [+] upload tile.
 *
 * Interactions:
 *   tap thumb       → setCurrentSource (the stream + input bar swap to it)
 *   long-press thumb→ archive (sets sources.archived_at; the thumb leaves)
 *   tap [+]         → opens the file picker (5-method input lives in InputBar
 *                      — the strip's [+] is the secondary "I want to add
 *                      another painting" affordance and just opens the
 *                      library picker for simplicity)
 *
 * Renders nothing if there are no active sources AND we're in the empty state
 * (page-level controls that). When at least one source exists, this is a
 * persistent header.
 */

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { useSources } from "@/hooks/useSources";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas, type Source } from "@/stores/canvas";

const LONG_PRESS_MS = 600;

function SourceThumb({
  source,
  isCurrent,
  onSelect,
  onArchive,
}: {
  source: Source;
  isCurrent: boolean;
  onSelect: () => void;
  onArchive: () => void;
}) {
  const { url } = useImageUrl(source.inputKey);
  const timerRef = useRef<number | null>(null);
  const archivedRef = useRef(false);

  const startPress = () => {
    archivedRef.current = false;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      archivedRef.current = true;
      const ok = window.confirm(
        "Archive this source?\nIt will leave the strip but its favorited tiles stay in Favorites.",
      );
      if (ok) onArchive();
      else archivedRef.current = false;
    }, LONG_PRESS_MS);
  };
  const endPress = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const onClick = () => {
    if (archivedRef.current) return; // long-press fired; don't also select
    onSelect();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onContextMenu={(e) => e.preventDefault()}
      className={[
        "relative h-14 w-14 shrink-0 overflow-hidden rounded-md",
        "ring-2 transition-all",
        isCurrent
          ? "ring-accent"
          : "ring-hairline/40 hover:ring-hairline",
        "no-callout",
      ].join(" ")}
      aria-label={isCurrent ? "Current source" : "Switch to this source"}
      aria-pressed={isCurrent}
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bloom-warm" aria-hidden />
      )}
    </button>
  );
}

export function SourceStrip() {
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const setCurrentSource = useCanvas((s) => s.setCurrentSource);
  const setFavoritesOpen = useCanvas((s) => s.setFavoritesOpen);
  const { archive, uploadFile } = useSources();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Auto-clear transient upload errors so the strip doesn't get stuck.
  useEffect(() => {
    if (!uploadError) return;
    const t = window.setTimeout(() => setUploadError(null), 4000);
    return () => window.clearTimeout(t);
  }, [uploadError]);

  if (sources.length === 0) return null;

  return (
    <header
      className={[
        "sticky top-0 z-30",
        "bg-background/85 backdrop-blur-md",
        "border-b border-hairline/60",
        "px-4 sm:px-6",
        "py-3",
      ].join(" ")}
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
    >
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3">
        <div className="flex flex-1 items-center gap-2 overflow-x-auto scrollbar-thin no-callout">
          {sources.map((s) => (
            <SourceThumb
              key={s.sourceId}
              source={s}
              isCurrent={s.sourceId === currentSourceId}
              onSelect={() => setCurrentSource(s.sourceId)}
              onArchive={() => {
                void archive(s.sourceId).catch((e) =>
                  setUploadError(e instanceof Error ? e.message : String(e)),
                );
              }}
            />
          ))}
          {/* Trailing add button */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={[
              "h-14 w-14 shrink-0 rounded-md",
              "border border-dashed border-hairline",
              "flex items-center justify-center",
              "text-text-mute hover:text-foreground hover:border-foreground/40",
              "transition-colors no-callout",
            ].join(" ")}
            aria-label="Add another source"
          >
            <Plus className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void uploadFile(file).catch((err) =>
                  setUploadError(err instanceof Error ? err.message : String(err)),
                );
              }
              e.target.value = "";
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setFavoritesOpen(true)}
          className={[
            "shrink-0 rounded-md px-3 py-2",
            "text-xs uppercase tracking-[0.18em]",
            "text-text-mute hover:text-foreground",
            "transition-colors no-callout",
          ].join(" ")}
          aria-label="Open favorites"
        >
          ★ Favorites
        </button>
      </div>

      {uploadError && (
        <p className="mx-auto mt-2 max-w-[1100px] text-xs text-destructive">
          {uploadError}
        </p>
      )}
    </header>
  );
}
