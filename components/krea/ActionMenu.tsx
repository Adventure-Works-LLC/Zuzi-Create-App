"use client";

/**
 * ActionMenu — small popover with 1–3 vertical action items, anchored to a
 * trigger element. The trigger lives in the parent (a "..." icon button on
 * a tile or source thumb); this component renders the popover surface +
 * scrim + Esc handling once the parent flips it open.
 *
 * Used in two places (so far):
 *   - Tile.tsx — top-left "..." icon → "Delete tile" with confirmation if
 *     the tile is favorited.
 *   - SourceStrip.tsx — top-right "..." icon on each source thumb → "Hide
 *     from strip" + "Delete forever". Also replaces the prior
 *     window.confirm-on-long-press path so the same code path serves both
 *     touch (long-press) and tap (icon) entry points.
 *
 * Design intent (per Zuzi's feature spec):
 *   - Discoverable. The "..." icon is always visible on touch devices, fades
 *     in on hover for desktop. The popover itself anchors to the icon so
 *     the user's eye doesn't have to chase it across the viewport.
 *   - Touch-target safe. Each menu item is ≥44px tall (Apple HIG) so a
 *     thumb can't fat-finger between adjacent items.
 *   - Dismiss by tap-outside (scrim absorbs the click), Esc, or selecting
 *     an item. The scrim is invisible (no `bg-black/40` etc) — this isn't
 *     a modal, it's a contextual menu, and dimming the rest of the UI
 *     would feel heavier than the action warrants.
 *   - Destructive items get a danger-tinted style. The component doesn't
 *     do confirmation itself; the parent handler decides whether to fire
 *     the action immediately or show a `window.confirm` (acceptable here
 *     because the confirm is the destructive guardrail, not the primary
 *     affordance).
 */

import { useEffect, useRef } from "react";

export interface ActionMenuItem {
  /** Stable key for React. */
  id: string;
  /** Visible label. Keep short (≤24 chars typical). */
  label: string;
  /** Optional 16x16 icon, usually a lucide-react component. */
  icon?: React.ReactNode;
  /** Render in a destructive color (red text). Confirmation, if any, is the
   *  caller's responsibility. */
  destructive?: boolean;
  /** Disable + grey out. */
  disabled?: boolean;
  /** Fired when the item is tapped. The menu closes automatically afterward
   *  (via the parent's `onClose`). The handler can be async; the menu
   *  doesn't await it. */
  onSelect: () => void;
}

export interface ActionMenuProps {
  /** Whether the menu is visible. The parent owns this state. */
  open: boolean;
  /** Closes the menu. Called on tap-outside, Esc, or after an item runs. */
  onClose: () => void;
  /** Items, top-to-bottom. 1–3 typical; the component handles arbitrary
   *  counts but more than 3 should probably be a bottom-sheet instead. */
  items: ActionMenuItem[];
  /** Anchor offset relative to the trigger. The popover renders into a
   *  fixed-positioned scrim and is positioned via CSS top/left supplied by
   *  the parent (which knows where its trigger sits). The default values
   *  pin it to the top-left of the viewport — overrideable. */
  position?: {
    top?: number | string;
    left?: number | string;
    right?: number | string;
    bottom?: number | string;
  };
  /** ARIA label for the menu surface. Should describe the context (e.g.
   *  "Tile actions", "Source actions"). Required for screen readers. */
  ariaLabel: string;
}

/**
 * Render the menu. The parent is responsible for positioning relative to
 * its trigger — usually by wrapping the trigger in a `relative` container
 * and passing `position={{ top: <some px>, right: <some px> }}` to anchor
 * the menu under or beside the icon. The component itself just renders
 * the surface + items + handles dismissal.
 */
export function ActionMenu({
  open,
  onClose,
  items,
  position,
  ariaLabel,
}: ActionMenuProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Esc-to-close. Window-level listener installed only when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus the first non-disabled item when the menu opens, for keyboard
  // navigation parity with macOS / iOS contextual menus.
  useEffect(() => {
    if (!open) return;
    const first = surfaceRef.current?.querySelector<HTMLButtonElement>(
      "button[data-menu-item]:not([disabled])",
    );
    first?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      // Invisible scrim — covers viewport so any tap outside the popover
      // dismisses. Not a `modal`-flavored dim because this is a contextual
      // menu, not a blocking dialog.
      className="fixed inset-0 z-50"
      onClick={(e) => {
        // Only fire onClose for taps on the scrim itself, not bubbling
        // from the popover surface.
        if (e.target === e.currentTarget) onClose();
      }}
      // Block scroll-through while the menu is open so a stray scroll
      // gesture doesn't slide content under the popover.
      onTouchMove={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={surfaceRef}
        role="menu"
        aria-label={ariaLabel}
        // Surface positioning: the parent passes anchor offsets; the popover
        // is fixed-position so it floats above the rest of the UI. Default
        // styling matches the rest of the app (warm card surface,
        // hairline border, soft shadow).
        style={{
          position: "fixed",
          ...(position ?? {}),
        }}
        className={[
          "min-w-[180px] rounded-lg",
          "bg-card",
          "border border-hairline",
          "shadow-lg shadow-black/30",
          "py-1",
          "no-callout",
        ].join(" ")}
        onClick={(e) => {
          // Prevent the scrim from receiving this click and dismissing.
          e.stopPropagation();
        }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-menu-item
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            className={[
              "w-full px-4 py-3 min-h-[44px]",
              "flex items-center gap-3",
              "text-sm text-left",
              "transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              item.destructive
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground hover:bg-secondary",
            ].join(" ")}
          >
            {item.icon && (
              <span className="flex h-4 w-4 items-center justify-center text-current">
                {item.icon}
              </span>
            )}
            <span className="flex-1">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
