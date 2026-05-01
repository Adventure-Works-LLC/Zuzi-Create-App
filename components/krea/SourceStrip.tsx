"use client";

/**
 * SourceStrip — sticky-top horizontal scroller of active sources, plus a
 * trailing [+] upload tile.
 *
 * Interactions:
 *   tap thumb        → setCurrentSource (the stream + input bar swap to it)
 *   tap "..." icon   → ActionMenu with Hide / Delete forever (top-right of
 *                       each thumb). The icon is the discoverable
 *                       affordance — Zuzi tried long-press, saw "archive",
 *                       and didn't know what would happen, so the icon is
 *                       there to invite exploration.
 *   long-press thumb → same ActionMenu opens (power-user shortcut). The
 *                       prior path used window.confirm directly which was
 *                       both undiscoverable AND blocked the iOS Safari
 *                       chrome from a clean experience; routing both paths
 *                       through one menu component fixes both bugs in one
 *                       structural change (resolves earlier audit
 *                       finding #4).
 *   tap [+]          → opens the file picker (5-method input lives in
 *                       InputBar — the strip's [+] is the secondary "I
 *                       want to add another painting" affordance and just
 *                       opens the library picker for simplicity).
 *
 * Right-side header chrome:
 *   ★ Favorites      → opens the FavoritesPanel (cross-source, archived
 *                       sources still visible).
 *   archive icon     → opens the HiddenSourcesPanel (this commit). Sized
 *                       small / muted so it doesn't compete with Favorites
 *                       — recovery is occasional, not daily.
 *
 * Renders nothing if there are no active sources AND we're in the empty
 * state (page-level controls that). When at least one source exists, this
 * is a persistent header.
 */

import { useEffect, useRef, useState } from "react";
import { Archive, EyeOff, MoreHorizontal, Plus, Trash2 } from "lucide-react";

import { useSources } from "@/hooks/useSources";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas, type Source } from "@/stores/canvas";
import { ActionMenu, type ActionMenuItem } from "./ActionMenu";

// 450ms < iOS native long-press (~500ms), so the gesture confirms before
// Safari's own callout/magnifier kicks in.
const LONG_PRESS_MS = 450;
// If the pointer drifts more than this (px) between down and the timer firing
// the user is scrolling the strip, not pressing — cancel the long-press.
const LONG_PRESS_MOVE_TOLERANCE = 10;

interface SourceThumbProps {
  source: Source;
  isCurrent: boolean;
  onSelect: () => void;
  onHide: () => void;
  onDeleteForever: () => void;
}

function SourceThumb({
  source,
  isCurrent,
  onSelect,
  onHide,
  onDeleteForever,
}: SourceThumbProps) {
  const { url } = useImageUrl(source.inputKey);
  const timerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
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

  const openMenuFromTrigger = () => {
    // Position the menu under the trigger icon's bottom-right edge so on
    // an iPad the popover floats just below where the user's finger
    // landed. The menu is min-w-[180px] and the thumbs are 56×56 so the
    // popover will extend to the right of the thumb — that's fine, it
    // floats over the iteration stream below.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
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
      // Long-press path opens the SAME menu the icon-tap path opens. One
      // code path serves both gestures; both produce a discoverable list
      // of options instead of the old window.confirm-on-archive that
      // gave no escape hatch.
      openMenuFromTrigger();
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
      // Movement => the user is scrolling, not long-pressing.
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

  const onMenuButton = (e: React.MouseEvent) => {
    // Stop bubble to the outer thumb button — the menu icon is its own
    // gesture, NOT a tile select.
    e.stopPropagation();
    openMenuFromTrigger();
  };

  const items: ActionMenuItem[] = [
    {
      id: "hide",
      label: "Hide from strip",
      icon: <EyeOff className="h-4 w-4" strokeWidth={1.75} />,
      onSelect: onHide,
    },
    {
      id: "delete",
      label: "Delete forever",
      icon: <Trash2 className="h-4 w-4" strokeWidth={1.75} />,
      destructive: true,
      onSelect: onDeleteForever,
    },
  ];

  return (
    <>
      <button
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
          "group relative h-14 w-14 shrink-0 overflow-hidden rounded-md",
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
        {/* Action-menu trigger — top-right corner. Always-visible affordance
            on touch (slight tint) so Zuzi can find it without long-press;
            full opacity on hover for desktop. The 24×24 visual hits the
            56×56 thumb's top-right so the touch target straddles the
            corner — generous enough for an iPad thumb without competing
            with the thumb-as-a-whole tap zone (which still works for
            switch). */}
        <span
          ref={triggerRef}
          onClick={onMenuButton}
          role="button"
          tabIndex={0}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Source actions"
          className={[
            "absolute top-0.5 right-0.5 z-10",
            "flex h-6 w-6 items-center justify-center rounded-full",
            "transition-all",
            // Touch baseline: visible-but-muted so users can find it.
            "bg-background/60 text-foreground/70",
            // Hover lift on desktop:
            "group-hover:bg-background/80 group-hover:text-foreground hover:bg-background hover:text-foreground",
          ].join(" ")}
        >
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      </button>
      {menuOpen && menuPos && (
        <ActionMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          position={{ top: menuPos.top, left: menuPos.left }}
          ariaLabel="Source actions"
          items={items}
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
  const setHiddenSourcesOpen = useCanvas((s) => s.setHiddenSourcesOpen);
  const { archive, deletePermanent, uploadFile } = useSources();
  const fileRef = useRef<HTMLInputElement>(null);
  const [transientError, setTransientError] = useState<string | null>(null);

  // Auto-clear transient errors so the strip doesn't get stuck. 4s is
  // enough to read a short error without lingering.
  useEffect(() => {
    if (!transientError) return;
    const t = window.setTimeout(() => setTransientError(null), 4000);
    return () => window.clearTimeout(t);
  }, [transientError]);

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
              onHide={() => {
                void archive(s.sourceId).catch((e) =>
                  setTransientError(e instanceof Error ? e.message : String(e)),
                );
              }}
              onDeleteForever={() => {
                // Permanent delete is the destructive guardrail — explicit
                // confirm before we drop a source row + its subtree from
                // both DB and R2. The wording names the cascade so the
                // user knows what they're losing (per Zuzi's spec).
                const ok = window.confirm(
                  "This permanently deletes this source and all generations made from it. This cannot be undone.\n\nDelete?",
                );
                if (!ok) return;
                void deletePermanent(s.sourceId).catch((e) =>
                  setTransientError(e instanceof Error ? e.message : String(e)),
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
                  setTransientError(
                    err instanceof Error ? err.message : String(err),
                  ),
                );
              }
              e.target.value = "";
            }}
          />
        </div>

        {/* Hidden sources affordance — small, muted; opens the
            HiddenSourcesPanel where Zuzi can restore or permanently
            delete archived sources. Sized smaller than Favorites because
            recovery is an occasional pass, not a daily one. */}
        <button
          type="button"
          onClick={() => setHiddenSourcesOpen(true)}
          className={[
            "shrink-0 rounded-md p-2",
            "text-text-mute/80 hover:text-foreground hover:bg-secondary",
            "transition-colors no-callout",
          ].join(" ")}
          aria-label="Open hidden sources"
          title="Hidden sources"
        >
          <Archive className="h-4 w-4" strokeWidth={1.75} />
        </button>

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

      {transientError && (
        <p className="mx-auto mt-2 max-w-[1100px] text-xs text-destructive">
          {transientError}
        </p>
      )}
    </header>
  );
}
