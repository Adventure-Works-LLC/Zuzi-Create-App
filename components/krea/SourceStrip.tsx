"use client";

/**
 * SourceStrip — sticky-top horizontal scroller of active sources, plus a
 * trailing [+] upload tile and an archive-folder button that opens the
 * ArchivedSourcesPanel.
 *
 * Interactions per source thumb:
 *   tap thumb       → setCurrentSource (the stream + input bar swap to it)
 *   long-press thumb→ opens ActionMenu floating popover with two items:
 *                       - Archive (soft, sets archived_at; thumb leaves
 *                         the strip but tile-favorites stay accessible
 *                         in the global Favorites view, and the row is
 *                         visible in the ArchivedSourcesPanel for later
 *                         unarchive / delete-forever).
 *                       - Delete Forever (hard, with window.confirm
 *                         gate; removes DB row, cascades iterations +
 *                         tiles, and cleans up R2 objects).
 *
 * Trailing affordances at the END of the strip:
 *   [+]    → opens file picker for a new upload (5-method input lives in
 *             InputBar; the strip's [+] is the secondary "I want to add
 *             another painting" affordance).
 *   [📁]   → opens ArchivedSourcesPanel (archive-folder icon; only renders
 *             when there's at least one source in the strip — when the
 *             active strip is empty the page-level empty state takes over
 *             and this header doesn't render at all).
 *
 * Renders nothing if there are no active sources AND we're in the empty
 * state. When at least one source exists, this is a persistent header.
 */

import { useEffect, useRef, useState } from "react";
import { Archive, Plus, Trash2 } from "lucide-react";

import { useSources } from "@/hooks/useSources";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas, type Source } from "@/stores/canvas";
import { ActionMenu } from "./ActionMenu";

// 450ms < iOS native long-press (~500ms), so the gesture confirms before
// Safari's own callout/magnifier kicks in.
const LONG_PRESS_MS = 450;
// If the pointer drifts more than this (px) between down and the timer firing
// the user is scrolling the strip, not pressing — cancel the long-press.
const LONG_PRESS_MOVE_TOLERANCE = 10;

function SourceThumb({
  source,
  isCurrent,
  onSelect,
  onArchive,
  onDeleteForever,
}: {
  source: Source;
  isCurrent: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDeleteForever: () => void;
}) {
  const { url } = useImageUrl(source.inputKey);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  // True once a long-press has fired and the menu is open. Prevents the
  // pointerup → click bubble from also calling onSelect (which would
  // switch source under the user's finger as they were trying to open
  // a menu).
  const longPressFiredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  const cancelTimer = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Open the action menu anchored beneath the thumb. Captures the
   *  trigger's viewport coords so the menu stays anchored if the strip
   *  re-renders. */
  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      // Anchor under the thumb's bottom-left + 4px gap. Menu is min-w-180
      // so it may extend right past the thumb (fine — fixed position
      // floats above the rest of the UI).
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setMenuOpen(true);
  };

  const startPress = (e: React.PointerEvent) => {
    longPressFiredRef.current = false;
    startPosRef.current = { x: e.clientX, y: e.clientY };
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      openMenu();
    }, LONG_PRESS_MS);
  };
  const onMove = (e: React.PointerEvent) => {
    const start = startPosRef.current;
    if (!start || !timerRef.current) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (
      dx * dx + dy * dy >
      LONG_PRESS_MOVE_TOLERANCE * LONG_PRESS_MOVE_TOLERANCE
    ) {
      // Movement => scrolling, not long-pressing.
      cancelTimer();
    }
  };
  const endPress = () => {
    cancelTimer();
    startPosRef.current = null;
  };
  const onClick = () => {
    if (longPressFiredRef.current) return; // long-press fired; don't also select
    onSelect();
  };

  const handleArchive = () => {
    setMenuOpen(false);
    onArchive();
  };

  const handleDeleteForever = () => {
    setMenuOpen(false);
    // window.confirm IS the destructive guardrail — same pattern as
    // tile-delete and as the ArchivedSourcesPanel's delete row. The
    // ActionMenu item already lives behind the long-press gesture, so
    // this is the "are you sure" confirm beat, not the only safeguard.
    const ok = window.confirm(
      "This permanently deletes this source and all generations made from it.\nThis cannot be undone. Delete?",
    );
    if (!ok) return;
    onDeleteForever();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        onPointerDown={startPress}
        onPointerMove={onMove}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onContextMenu={(e) => e.preventDefault()}
        // touch-action: pan-x lets the browser claim the gesture for horizontal
        // scroll early and emit pointercancel, releasing the long-press timer
        // before it can fire spuriously.
        style={{ touchAction: "pan-x" }}
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
      {menuOpen && menuPos && (
        <ActionMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          position={{ top: menuPos.top, left: menuPos.left }}
          ariaLabel="Source actions"
          items={[
            {
              id: "archive",
              label: "Archive",
              icon: <Archive className="h-4 w-4" strokeWidth={1.75} />,
              onSelect: handleArchive,
            },
            {
              id: "delete-forever",
              label: "Delete forever",
              icon: <Trash2 className="h-4 w-4" strokeWidth={1.75} />,
              destructive: true,
              onSelect: handleDeleteForever,
            },
          ]}
        />
      )}
    </>
  );
}

export function SourceStrip() {
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const setCurrentSource = useCanvas((s) => s.setCurrentSource);
  const setFavoritesOpen = useCanvas((s) => s.setFavoritesOpen);
  const setArchivedSourcesPanelOpen = useCanvas(
    (s) => s.setArchivedSourcesPanelOpen,
  );
  const { archive, deleteForever, uploadFile } = useSources();
  const fileRef = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-clear transient errors so the strip doesn't get stuck.
  useEffect(() => {
    if (!actionError) return;
    const t = window.setTimeout(() => setActionError(null), 4000);
    return () => window.clearTimeout(t);
  }, [actionError]);

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
                  setActionError(e instanceof Error ? e.message : String(e)),
                );
              }}
              onDeleteForever={() => {
                void deleteForever(s.sourceId).catch((e) =>
                  setActionError(e instanceof Error ? e.message : String(e)),
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
          {/* Archive panel access. Sits AFTER the [+] so the upload affordance
              stays adjacent to the active sources (the user's natural
              left-to-right scan: thumbs → add → archive). The icon is
              always rendered when the strip is mounted (i.e., at least one
              active source); empty-archive state lives inside the panel
              ("No archived sources"). Discoverability comes from
              proximity to the active strip rather than corner-real-estate. */}
          <button
            type="button"
            onClick={() => setArchivedSourcesPanelOpen(true)}
            className={[
              "h-14 w-14 shrink-0 rounded-md",
              "border border-hairline/60",
              "flex items-center justify-center",
              "text-text-mute hover:text-foreground hover:border-foreground/40 hover:bg-secondary",
              "transition-colors no-callout",
            ].join(" ")}
            aria-label="Archived sources"
          >
            <Archive className="h-5 w-5" strokeWidth={1.5} />
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
                  setActionError(
                    err instanceof Error ? err.message : String(err),
                  ),
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

      {actionError && (
        <p className="mx-auto mt-2 max-w-[1100px] text-xs text-destructive">
          {actionError}
        </p>
      )}
    </header>
  );
}
