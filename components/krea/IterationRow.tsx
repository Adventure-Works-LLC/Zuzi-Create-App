"use client";

/**
 * IterationRow — the N tiles produced by one Submit, in a horizontal row of
 * tiles whose container aspect ratio matches the SOURCE (AGENTS.md §3, output
 * aspect == input aspect). Each row is one iteration; rows stack vertically
 * with newest at top inside the TileStream.
 *
 * Layout invariant: tile width is determined by VIEWPORT, NEVER by tile
 * count. Generating 1 tile renders one tile at canonical width with empty
 * space to its right; generating 3 tiles renders three tiles at the SAME
 * canonical width filling the row; generating more wraps at the same
 * canonical width. This is the opposite of the "auto-fill / fill the row"
 * grid behavior — tiles are size-stable so a one-tile run feels like a
 * one-tile run, not a giant single banner.
 *
 * Width formula (single CSS clamp, applied via inline style):
 *
 *     width: clamp(218px, calc((100vw - 88px) / 3), 358px)
 *
 * The middle term is the math for "exactly 3 tiles fit per row given the
 * outer container's px-8 padding (32 each side = 64) plus the two 12px
 * gaps between three tiles (= 24); 64 + 24 = 88". So at any viewport that
 * fits between the floor and the ceiling, the natural width is exactly the
 * 3-up size for that viewport.
 *
 *   - 218px floor: keeps 3-up working on iPad mini portrait (744 viewport,
 *     inner ≈ 680px). 3*218 + 24 = 678 — fits with 2px to spare.
 *   - 358px ceiling: caps tiles at the max width that fits 3-up inside the
 *     TileStream's max-w-[1100px] inner container. 3*358 + 24 = 1098 ≤
 *     1100, single row guaranteed. (The naïve 360 ceiling overflowed by
 *     4px and wrapped the 3rd tile to row 2 in landscape — verified via
 *     DOM measurement.)
 *   - Sample sizes between: iPad Pro 11 portrait (834) → 249px; iPad Pro
 *     12.9 portrait (1024) → 312px; any landscape iPad → 358px (clamps to
 *     ceiling). All fit 3-up on a single row.
 *
 * Earlier commit 9c10d52 had this inverted (portrait=360, landscape=280),
 * which made portrait wrap 3 tiles to 2 rows because 3*360 > 810. Confirmed
 * with iPad portrait math; do not revert.
 *
 * The container is `flex flex-wrap`, not CSS grid with `1fr` columns, so
 * children honor their fixed width and wrap naturally if a row genuinely
 * doesn't fit (e.g. tile_count = 9 wraps to 3 rows of 3).
 *
 * Caption above the row (small, muted): "<time> · <tier> <res>" plus preset
 * chips if any were checked. Empty preset set just shows "(make beautiful)".
 *
 * Iteration-level controls (top-right of the heading area):
 *   - "..." trigger → ActionMenu with "Delete this generation" (always
 *     available regardless of status) and, on stuck iterations, a
 *     "Try to recover" item.
 *
 * Stuck-state UI: after `STUCK_THRESHOLD_MS` (2 minutes) of an iteration
 * remaining in pending/running status, the row swaps the normal caption
 * for a "may have been interrupted" banner with inline Recover + Delete
 * actions. Tiles are passed `frozen={true}` so their loading pulse stops
 * — the static state communicates "wait isn't going to fix this."
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";

import { Tile } from "./Tile";
import { ActionMenu } from "./ActionMenu";
import { useCanvas } from "@/stores/canvas";
import { useIterations } from "@/hooks/useIterations";

const PRESET_LABEL: Record<string, string> = {
  color: "color",
  ambiance: "ambiance",
  lighting: "lighting",
  background: "background",
};

/** Inline style for the per-tile fixed width. See file header for the
 *  derivation of the clamp values. Inline `style` instead of a Tailwind
 *  arbitrary-value class because nested `calc()` inside `clamp()` inside
 *  `w-[...]` trips up the JIT in Tailwind 4. */
const TILE_WIDTH_STYLE: React.CSSProperties = {
  width: "clamp(218px, calc((100vw - 88px) / 3), 358px)",
};

/** Threshold after which an iteration in pending/running status is
 *  considered "stuck or interrupted." 2 minutes is a generous bound:
 *  Pro 1K typical generation is 10–15s/tile and we run them in parallel,
 *  so a healthy 9-tile iteration completes well under 60s. Anything
 *  past 2 minutes with no SSE event is almost certainly a worker that
 *  died from a redeploy or transient crash, and the user deserves
 *  affordances to recover or move on. */
const STUCK_THRESHOLD_MS = 2 * 60_000;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface IterationRowProps {
  /** Iteration id; the row subscribes to its own iteration object via a
   *  selector that returns a stable reference for unrelated iterations.
   *  This means an SSE tile event for a different iteration's tile does
   *  NOT re-render this row. See TileStream.tsx file header. */
  iterationId: string;
  /** Pre-resolved display aspect ratio in "W:H" form, hoisted into
   *  TileStream so we don't subscribe to sources[] from every row. */
  aspectRatio: string;
}

export const IterationRow = memo(function IterationRow({
  iterationId,
  aspectRatio,
}: IterationRowProps) {
  // Subscribe to JUST this iteration object. Zustand returns the same
  // reference for unrelated iterations across mutations, so this row only
  // re-renders when its own iteration's reference changes (the tile that
  // updated belongs to this row, or status / tiles[] reshuffled). Unrelated
  // SSE tile events leave this selector's output referentially equal and
  // the subscribed component skips render entirely.
  const iteration = useCanvas((s) =>
    s.iterations.find((i) => i.id === iterationId),
  );
  const { deleteIteration, recoverIteration } = useIterations();

  // Hooks below MUST be called unconditionally (rules of hooks) — declare
  // them before the early return. Iteration-derived values use safe
  // defaults when iteration is undefined; the early return after the hook
  // block prevents any of those default-derived values from rendering.
  const optimistic = iteration?.id.startsWith("opt-") ?? false;

  const presets = iteration?.presets;
  const presetLabel = useMemo(() => {
    if (!presets || presets.length === 0) return "make beautiful";
    return presets.map((p) => PRESET_LABEL[p]).join(" · ");
  }, [presets]);

  // Stuck detection: pending/running iteration past STUCK_THRESHOLD_MS
  // since createdAt. Timer-driven so the UI updates even when no SSE
  // events fire (which is exactly the stuck case — no events means
  // nothing's coming back). Cleared as soon as the iteration leaves
  // pending/running OR the row unmounts.
  const isPendingOrRunning =
    iteration?.status === "pending" || iteration?.status === "running";
  const createdAt = iteration?.createdAt ?? 0;
  const [isStuck, setIsStuck] = useState(false);
  useEffect(() => {
    if (!isPendingOrRunning || optimistic) {
      setIsStuck(false);
      return;
    }
    const elapsed = Date.now() - createdAt;
    if (elapsed >= STUCK_THRESHOLD_MS) {
      setIsStuck(true);
      return;
    }
    const remaining = STUCK_THRESHOLD_MS - elapsed;
    const t = window.setTimeout(() => setIsStuck(true), remaining);
    return () => window.clearTimeout(t);
  }, [isPendingOrRunning, createdAt, optimistic]);

  // Iteration-level ActionMenu state. Anchored to the "..." trigger.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const [busy, setBusy] = useState<"delete" | "recover" | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Anchor the menu under the trigger's bottom-right corner. Using
      // `right: window.innerWidth - rect.right` keeps the menu hugging
      // the right edge of the trigger (the items can extend leftward
      // freely without overflowing the viewport). +4px gap.
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setMenuOpen(true);
  };

  const handleDelete = () => {
    setMenuOpen(false);
    // Hard-delete uses the same window.confirm guardrail pattern as
    // tile / source deletes elsewhere. The user must always reach a
    // deletable state — even an animating-pending iteration accepts
    // the click (per the reliability spec).
    const ok = window.confirm(
      "Delete this generation?\nAll tiles in this run will be removed. This cannot be undone.",
    );
    if (!ok) return;
    setBusy("delete");
    setBannerError(null);
    void deleteIteration(iterationId)
      .catch((err) => {
        // Optimistic removal already rolled back inside the hook. Surface
        // the error inline.
        const message = err instanceof Error ? err.message : String(err);
        setBannerError(`Couldn't delete: ${message}`);
      })
      .finally(() => setBusy(null));
  };

  const handleRecover = () => {
    setMenuOpen(false);
    setBusy("recover");
    setBannerError(null);
    void recoverIteration(iterationId)
      .then((result) => {
        // Useful telemetry for the wild — the user's tap mirrors the
        // boot sweep, and the outcome explains what happened. The
        // result already carries `iterationId`; spread alone is fine.
        console.info("[iteration] recover", result);
        if (result.outcome === "failed_no_tiles") {
          // Iteration is now `failed`. The refetch already pulled the
          // new state; surface a hint that recovery couldn't save it.
          setBannerError(
            "Recovery couldn't find any completed tiles — marked failed. You can delete this generation.",
          );
        } else if (result.outcome === "deferred") {
          // R2 returned a non-404 error during recovery — auth blip,
          // transient 5xx, network timeout. Iteration still pending;
          // the stuck banner stays visible. Tell the user it was a
          // storage hiccup so the next tap (or boot retry) makes
          // sense rather than feeling like the button does nothing.
          setBannerError(
            "Storage check couldn't complete — try again in a moment, or delete if you'd rather move on.",
          );
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setBannerError(`Couldn't recover: ${message}`);
      })
      .finally(() => setBusy(null));
  };

  // Inline-banner buttons — duplicated from the menu items so they're
  // discoverable in the stuck UI without making the user open the menu.
  // Disabled during in-flight operations so a double-tap doesn't fire
  // both paths.
  const inlineRecoverDisabled = busy !== null;
  const inlineDeleteDisabled = busy !== null;

  // The optimistic placeholder shouldn't expose iteration-level
  // actions (no DB row yet to delete/recover against). Keep the menu
  // hidden until the swap to the canonical id lands.
  const showActionMenu = !optimistic;

  // Iteration disappeared from the store between the parent's selector
  // run and ours (e.g. removeIteration ran in a microtask). Render
  // nothing — the parent will rebuild without us on next tick.
  if (!iteration) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <span className="caption-display text-xs text-text-mute">
          <span className="text-foreground/80">{presetLabel}</span>
          <span className="mx-2 text-text-mute/50">·</span>
          {iteration.modelTier} {iteration.resolution}
          <span className="mx-2 text-text-mute/50">·</span>
          {formatTime(iteration.createdAt)}
        </span>
        <div className="flex items-center gap-2">
          {iteration.status === "failed" && !isStuck && (
            // Two paths land here:
            //   - optimistic id (`opt-...`) → POST /api/iterate failed before the
            //     worker ever ran. "couldn't submit" matches the UX.
            //   - real iteration id with all tiles blocked/failed → the worker
            //     ran but produced 0 successful tiles. Each tile renders its own
            //     blocked/failed indicator inside, so the caption just needs to
            //     say "the whole iteration failed, retry."
            <span className="text-destructive text-xs">
              {iteration.id.startsWith("opt-")
                ? "couldn’t submit"
                : "no tiles generated — try again"}
            </span>
          )}
          {showActionMenu && (
            <button
              ref={triggerRef}
              type="button"
              onClick={openMenu}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Generation actions"
              className={[
                // 44×44 = Apple HIG minimum tap target. Earlier 32×32
                // was below HIG and matched neither the per-tile star
                // (h-12 w-12) nor the "..." (h-12 w-12) treatment.
                "flex h-11 w-11 items-center justify-center rounded-full",
                "text-text-mute hover:text-foreground hover:bg-secondary",
                "transition-colors no-callout",
              ].join(" ")}
            >
              <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Stuck banner. Replaces the normal pending caption when the
          2-minute threshold fires. Inline Recover + Delete buttons —
          the spec calls for "prominent" affordances, so they're
          duplicated here even though the same actions are reachable
          via the menu. */}
      {isStuck && (
        <div
          role="alert"
          className={[
            "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
            "rounded-md border border-hairline/60 bg-secondary/40",
            "px-3 py-2 mx-1",
          ].join(" ")}
        >
          <div className="flex items-start gap-2 text-xs text-foreground/85">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-text-mute"
              strokeWidth={1.75}
            />
            <span>
              This generation may have been interrupted. Try recovering or
              delete.
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleRecover}
              disabled={inlineRecoverDisabled}
              className={[
                "inline-flex items-center gap-1.5 rounded-full",
                "px-3 py-1.5 text-xs font-medium",
                "border border-hairline/80",
                "text-foreground hover:bg-background",
                "transition-colors no-callout",
                "disabled:opacity-50 disabled:cursor-wait",
              ].join(" ")}
            >
              <RotateCw
                className={[
                  "h-3.5 w-3.5",
                  busy === "recover" ? "animate-spin" : "",
                ].join(" ")}
                strokeWidth={1.75}
              />
              {busy === "recover" ? "Recovering…" : "Recover"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={inlineDeleteDisabled}
              className={[
                "inline-flex items-center gap-1.5 rounded-full",
                "px-3 py-1.5 text-xs font-medium",
                "text-destructive hover:bg-destructive/10",
                "transition-colors no-callout",
                "disabled:opacity-50 disabled:cursor-wait",
              ].join(" ")}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}

      {bannerError && (
        <p className="px-1 text-xs text-destructive" role="alert">
          {bannerError}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {iteration.tiles.map((tile) => (
          <div key={tile.id} className="flex-none" style={TILE_WIDTH_STYLE}>
            <Tile
              tile={tile}
              aspectRatio={aspectRatio}
              optimistic={optimistic}
              frozen={isStuck}
            />
          </div>
        ))}
      </div>

      {menuOpen && menuPos && (
        <ActionMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          position={{ top: menuPos.top, right: menuPos.right }}
          ariaLabel="Generation actions"
          items={[
            ...(isStuck
              ? [
                  {
                    id: "recover",
                    label: busy === "recover" ? "Recovering…" : "Try to recover",
                    icon: <RotateCw className="h-4 w-4" strokeWidth={1.75} />,
                    disabled: busy !== null,
                    onSelect: handleRecover,
                  },
                ]
              : []),
            {
              id: "delete",
              label: busy === "delete" ? "Deleting…" : "Delete this generation",
              icon: <Trash2 className="h-4 w-4" strokeWidth={1.75} />,
              destructive: true,
              disabled: busy !== null,
              onSelect: handleDelete,
            },
          ]}
        />
      )}
    </section>
  );
});
