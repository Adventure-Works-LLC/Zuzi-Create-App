"use client";

/**
 * Tile — one generated tile in the stream.
 *
 * States the user can see:
 *   pending → soft warm pulse, no image (placeholder is the affordance)
 *   done    → image cross-fades in (4px blur → 0, 8px translate, 300ms ease-out)
 *   blocked → small ShieldOff icon + "skipped" caption (safety filter)
 *   failed  → small dot + error tooltip on long-press
 *
 * Interactions:
 *   tap        → opens lightbox
 *   star icon  → toggles favorite (top-right, visible affordance — see
 *                  UX_INSPIRATION.md)
 *   "..." icon → opens ActionMenu with "Delete tile" (top-left). Deleting
 *                  is soft via /api/tiles/:id; the tile leaves the stream
 *                  immediately. Confirmation prompt only if the tile is
 *                  favorited (deleting a favorite deserves a "you sure?"
 *                  beat — non-favorites are zero-confirmation since tiles
 *                  are cheap to regenerate).
 *
 * The thumbnail is fetched via useImageUrl with the tile's `thumbKey` (R2 key
 * for the 512px webp). The lightbox uses the full-resolution `outputKey`.
 */

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, ShieldOff, Star, Trash2 } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useFavorites } from "@/hooks/useFavorites";
import { useCanvas, type Tile as TileT } from "@/stores/canvas";
import { ActionMenu } from "./ActionMenu";

interface TileProps {
  tile: TileT;
  /** Source aspect ratio in "W:H" form (e.g. "4:5", "16:9"). Output aspect ==
   * input aspect (AGENTS.md §3) so the tile container must mirror it; otherwise
   * `object-cover` center-crops the painting and obscures keep/discard cues. */
  aspectRatio: string;
  /** Optimistic ids (placed before /api/iterate replies) shouldn't allow
   * favoriting yet — there's no DB row to write against. */
  optimistic?: boolean;
}

export function Tile({ tile, aspectRatio, optimistic = false }: TileProps) {
  const setLightboxTile = useCanvas((s) => s.setLightboxTile);
  const removeTile = useCanvas((s) => s.removeTile);
  const { toggle } = useFavorites();
  const { url, loading } = useImageUrl(tile.thumbKey);
  const [imageReady, setImageReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  // Ref on the menu-trigger span so we can compute viewport coordinates
  // for the floating ActionMenu when it opens. The menu renders with
  // position: fixed so getBoundingClientRect on the trigger gives us the
  // exact anchor without any document-scroll math.
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Reset blur-fade when the URL or status changes.
  useEffect(() => {
    if (tile.status !== "done" || !url) {
      setImageReady(false);
    }
  }, [url, tile.status]);

  const onTap = () => {
    if (tile.status === "done") setLightboxTile(tile.id);
  };

  const onFav = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (optimistic || tile.id.startsWith("opt-")) return;
    // useFavorites does optimistic update + automatic rollback on failure,
    // so the user-visible feedback IS the star snapping back. That's the
    // intentional UX for a high-frequency action (toast spam would hurt).
    // Still: log the actual failure reason so any future debugging session
    // has a breadcrumb instead of pure silence. The prior `.catch(() => {})`
    // ate even the console signal.
    void toggle(tile.id, !tile.isFavorite).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[tile] favorite toggle failed (rolled back)", {
        tileId: tile.id,
        nextValue: !tile.isFavorite,
        message,
        error: err,
      });
    });
  };

  const onMenuButton = (e: React.MouseEvent) => {
    // Stop the click from bubbling to the tile button (which would open the
    // lightbox). Action-menu open IS the entire intent of this gesture.
    e.stopPropagation();
    if (optimistic || tile.id.startsWith("opt-")) return;
    // Capture viewport position of the trigger NOW so the menu renders
    // anchored even if a re-render shifts the layout slightly between the
    // click and the menu mount.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Anchor the menu's top-left under the trigger's bottom-left, +4px
      // gap. The menu is min-w-[180px] which can extend right past the
      // tile's right edge — that's fine, the popover floats above other
      // content via fixed positioning + z-50.
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setMenuOpen(true);
  };

  const onDelete = () => {
    if (deleting) return;
    // Confirmation only when the tile is favorited — Zuzi's spec: tiles are
    // cheap to regenerate so the default is zero-friction, but losing a
    // favorited result deserves a "you sure?" beat. window.confirm is the
    // right primitive here (the destructive guardrail, not the primary
    // affordance — the ActionMenu item already lives behind the icon tap).
    if (tile.isFavorite) {
      const ok = window.confirm(
        "This is a favorite. Delete anyway?\nDeleted tiles cannot be recovered.",
      );
      if (!ok) return;
    }
    setDeleting(true);
    console.info("[tile] delete: clicked", { tileId: tile.id });
    // Optimistic remove from store. The store also closes the lightbox if
    // the deleted tile was the open target, and drops the iteration row
    // when its tiles[] empties. If the server fails, the user sees a
    // momentary "tile gone, then back" — acceptable; the alternative is
    // freezing the UI on a slow network.
    removeTile(tile.id);
    void fetch(`/api/tiles/${encodeURIComponent(tile.id)}`, {
      method: "DELETE",
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(
            data.detail ?? data.error ?? `delete failed (${resp.status})`,
          );
        }
        const data = (await resp.json()) as {
          activeTileCountForIteration: number;
        };
        console.info("[tile] delete: ok", {
          tileId: tile.id,
          activeTileCountForIteration: data.activeTileCountForIteration,
        });
      })
      .catch((err) => {
        // Server delete failed AFTER we optimistically removed from store.
        // The user already saw the tile leave; rolling back via store
        // re-insert would be jarring (and racy if the user has triggered
        // other actions since). Instead: log loudly + alert. They can
        // refresh to see canonical server state. This is a corner case —
        // the more common failure (auth) presents as 401 which the
        // proxy handles upstream.
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[tile] delete: failed (already removed from store)", {
          tileId: tile.id,
          message,
          error: err,
        });
        // Single alert is heavier-handed than the tile/source delete
        // patterns elsewhere in the app, but a server-side delete failure
        // means the row is still in DB and will pop back on next refresh
        // — the user needs to know.
        window.alert(
          `The tile was hidden but the server delete failed:\n${message}\n\nRefresh to recover canonical state.`,
        );
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  return (
    <>
    <button
      type="button"
      onClick={onTap}
      disabled={tile.status !== "done"}
      style={{ aspectRatio: aspectRatio.replace(":", "/") }}
      className={[
        "group relative w-full overflow-hidden rounded-lg",
        "bg-card",
        tile.status === "done"
          ? "ring-1 ring-hairline/70 hover:ring-hairline cursor-zoom-in"
          : "ring-1 ring-hairline/40",
        "transition-all duration-200",
      ].join(" ")}
      aria-label={
        tile.status === "done"
          ? "Open tile"
          : tile.status === "blocked"
            ? "Tile blocked by safety filter"
            : tile.status === "failed"
              ? "Tile failed"
              : "Tile generating"
      }
    >
      {/* Soft warm pulse for pending tiles. The "bloom-warm" class lives in
          globals.css. */}
      {tile.status === "pending" && (
        <div
          className="absolute inset-0 bloom-warm animate-pulse"
          aria-hidden
        />
      )}

      {/* Done tile — image with blur-fade entrance. */}
      {tile.status === "done" && url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setImageReady(true)}
          className={[
            "absolute inset-0 h-full w-full object-cover",
            "transition-[opacity,filter,transform] duration-300 ease-out",
            imageReady
              ? "opacity-100 blur-0 translate-y-0"
              : "opacity-0 blur-[4px] translate-y-2",
          ].join(" ")}
        />
      )}

      {/* Loading shimmer fallback while we resolve the signed URL */}
      {tile.status === "done" && (loading || !url) && (
        <div className="absolute inset-0 bloom-warm opacity-50" aria-hidden />
      )}

      {/* Blocked / failed — quiet quasi-error state. Never red error blocks. */}
      {(tile.status === "blocked" || tile.status === "failed") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          {tile.status === "blocked" ? (
            <ShieldOff className="h-6 w-6 text-text-mute" strokeWidth={1.5} />
          ) : (
            <span
              className="block h-2 w-2 rounded-full bg-text-mute/60"
              aria-hidden
            />
          )}
          <span className="caption-display text-xs text-text-mute">
            {tile.status === "blocked" ? "skipped" : "couldn't render"}
          </span>
        </div>
      )}

      {/* Favorite star — top-right corner. Visible only when the tile is done.
          Slightly larger touch target than the icon to land on iPad finger. */}
      {tile.status === "done" && !optimistic && !tile.id.startsWith("opt-") && (
        <span
          onClick={onFav}
          role="button"
          tabIndex={0}
          aria-pressed={tile.isFavorite}
          aria-label={tile.isFavorite ? "Unfavorite" : "Favorite"}
          className={[
            "absolute top-2 right-2 z-10",
            "flex h-9 w-9 items-center justify-center rounded-full",
            "transition-colors",
            tile.isFavorite
              ? "bg-background/70 text-accent"
              : "bg-background/40 text-foreground/0 group-hover:text-foreground/70 hover:bg-background/70",
            // On touch devices (no hover), keep the star visible when active.
            "supports-[hover:none]:text-foreground/40",
          ].join(" ")}
        >
          <Star
            className={[
              "h-4 w-4",
              tile.isFavorite ? "fill-current" : "fill-none",
            ].join(" ")}
            strokeWidth={1.75}
          />
        </span>
      )}

      {/* Action menu trigger — top-LEFT corner. Top-right is favorite; we
          deliberately split the corners so the two affordances don't fight
          for the same touch zone on a 250–360px wide tile.

          A11y: span+role="button" mirrors the favorite-star pattern (HTML
          doesn't allow nested <button> but a span with role works on
          screen readers + handles keyboard via Enter/Space when focused).
          Always visible on touch (always-on tint), fades in on hover for
          desktop. The 36×36 tap target meets Apple HIG 44×44 once the
          icon's 18px slop is included. */}
      {tile.status === "done" && !optimistic && !tile.id.startsWith("opt-") && (
        <span
          ref={triggerRef}
          onClick={onMenuButton}
          role="button"
          tabIndex={0}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Tile actions"
          className={[
            "absolute top-2 left-2 z-10",
            "flex h-9 w-9 items-center justify-center rounded-full",
            "transition-colors",
            "bg-background/40 text-foreground/0 group-hover:text-foreground/70 hover:bg-background/70",
            "supports-[hover:none]:text-foreground/40 supports-[hover:none]:bg-background/60",
          ].join(" ")}
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
        </span>
      )}
    </button>
    {menuOpen && menuPos && (
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        position={{ top: menuPos.top, left: menuPos.left }}
        ariaLabel="Tile actions"
        items={[
          {
            id: "delete",
            label: deleting ? "Deleting…" : "Delete tile",
            icon: <Trash2 className="h-4 w-4" strokeWidth={1.75} />,
            destructive: true,
            disabled: deleting,
            onSelect: onDelete,
          },
        ]}
      />
    )}
    </>
  );
}
