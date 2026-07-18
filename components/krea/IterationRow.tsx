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
import { StyleAttributionThumb } from "./StyleAttributionThumb";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useCanvas } from "@/stores/canvas";
import { useShallow } from "zustand/react/shallow";
import { useIterations } from "@/hooks/useIterations";
import { authFetch } from "@/lib/auth/authFetch";
import { TIMEOUT_JSON_MS, withTimeout } from "@/lib/fetchTimeout";
import { varyStrengthLabel } from "@/lib/fal/varyConstants";

// Mirrors VISIBLE_PRESETS + hidden presets in InputBar.tsx — labels for
// the iteration caption chip. Missing entries fall through to literal
// "undefined" in the rendered caption, which was the bug before Avery
// + Etching were added: any iteration whose presets included one of
// those (notably the v2.4 "Iterate on this direction" handoff, which
// uses the store's default ['avery']) caption-rendered as "undefined".
const PRESET_LABEL: Record<string, string> = {
  color: "color",
  ambiance: "ambiance",
  lighting: "lighting",
  background: "background",
  avery: "avery",
  etching: "etching",
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
  const mode = iteration?.mode;
  const blendInputCount = iteration?.blendTileIds?.length ?? 0;
  const varyStrength = iteration?.varyStrength ?? null;
  const keepSourceColors = iteration?.keepSourceColors ?? false;

  // v5.2: classify a fully-failed iteration by its tiles' recorded
  // errors so the caption gives honest advice. "Try again" is actively
  // wrong for Google's DAILY quota (429 per_model_per_day — retrying
  // burns nothing but fails for hours) and merely unhelpful for a
  // per-minute rate limit (right advice: wait a minute). The worker
  // stores the raw classified message on every failed tile; we only
  // need a coarse read here.
  const failureKind = useMemo(() => {
    if (iteration?.status !== "failed") return null;
    const tiles = iteration?.tiles ?? [];
    // v5.4.1: every tile safety-blocked = the ENGINE's content filter
    // refused the inputs (observed live: BFL's input moderation false-
    // positives on some of her crayon figures — engine-side, at every
    // tolerance). "Try again" can't fix it; switching engines can.
    if (
      tiles.length > 0 &&
      tiles.every((t) => t.status === "blocked")
    )
      return "engine_censor";
    const msgs = tiles
      .map((t) => t.errorMessage)
      .filter((m): m is string => !!m);
    if (msgs.some((m) => m.includes("per_model_per_day"))) return "daily_quota";
    if (
      msgs.some(
        (m) =>
          m.includes("RESOURCE_EXHAUSTED") ||
          m.includes("exceeded your current quota") ||
          m.includes('"code":429'),
      )
    )
      return "rate_limited";
    return "generic";
  }, [iteration?.status, iteration?.tiles]);
  const presetLabel = useMemo(() => {
    // v3.5: blend iterations get their own caption. The "Blend of N
    // [thumbs]" attribution row above the tile grid shows which
    // inputs drove the blend; this caption gives the iteration its
    // type-label so the user doesn't see "(make beautiful)" — which
    // is technically true (the blend directive IS the freeform v0
    // mood) but misleading next to "Blend of …".
    if (mode === "style_blend") {
      return blendInputCount > 0 ? `blend of ${blendInputCount}` : "blend";
    }
    // v5: vary iterations caption as "vary · subtle/medium/wild" — the
    // strength is the only per-run knob, so it IS the caption.
    if (mode === "sketch_vary") {
      const label = varyStrengthLabel(varyStrength);
      return label ? `vary · ${label}` : "vary";
    }
    // v5.4.1: style_explore rows always have empty presets (the locked
    // directive bypasses the ladder), so they'd previously fall through
    // to "make beautiful" — wrong label since v2. Name the mode.
    // v5.6: caption the "Her colors" switch state so she can tell the
    // two directive variants apart in the stream.
    if (mode === "style_explore")
      return keepSourceColors ? "style explore · her colors" : "style explore";
    if (!presets || presets.length === 0) return "make beautiful";
    return presets.map((p) => PRESET_LABEL[p]).join(" · ");
  }, [presets, mode, blendInputCount, varyStrength, keepSourceColors]);

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
          {iteration.mode === "sketch_vary"
            ? "her lora"
            : `${
                iteration.modelTier === "flux2max"
                  ? "flux max"
                  : iteration.modelTier
              } ${iteration.resolution}`}
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
                : failureKind === "engine_censor"
                  ? "this engine’s content filter refused the image — it misreads some of her figures; Pro and Seedream handle it"
                  : failureKind === "daily_quota"
                    ? "Google’s daily limit for this model is used up — switch tiers (Flash/Pro) or use Vary; it resets overnight"
                    : failureKind === "rate_limited"
                      ? "Google is rate-limiting — wait a minute, then try again"
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

      {/* v3.4: per-iteration blend attribution. Blend iterations carry
          their N input TILE ids on `iteration.blendTileIds` (NOT
          style painting ids — v3.4 corrected the interpretation: blend
          inputs are tiles she generated earlier, not raw style refs).
          Same-source rule means every input tile id resolves cleanly
          from the current source's iterations[]. Render attribution
          ONCE per iteration above the tile row so the user can see
          which tiles drove the blend. Same "no overlay on the painting
          surface" rule (see Tile.tsx header). */}
      {iteration.mode === "style_blend" &&
        iteration.blendTileIds.length > 0 && (
          <BlendTileAttributionRow tileIds={iteration.blendTileIds} />
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
            {/* v2.4: per-tile style attribution. Renders for every
                tile that carries a style_painting_id — covers both
                style_explore tiles AND prompt-mode tiles spawned via
                the "Iterate on this direction" handoff (the handoff
                copies the single stylePaintingId onto every tile of
                the new iteration). Sits BELOW the tile's action row
                per the no-overlay rule (see Tile.tsx header).
                Blend tiles always have stylePaintingId=null —
                their attribution is rendered ONCE for the whole
                iteration row above. */}
            {tile.stylePaintingId && (
              <StyleAttributionThumb
                stylePaintingId={tile.stylePaintingId}
              />
            )}
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

/** v3.4 blend attribution row. Renders "Blend of [thumb] [thumb] …"
 *  where each thumb is the THUMB_KEY of an input tile (looked up
 *  in the current source's iterations[]). Same-source rule means
 *  the lookup always hits as long as the iteration is still in
 *  the store. If an input tile was deleted between blend time and
 *  view time, the thumb renders an italicized "unavailable"
 *  fallback — matches StyleAttributionThumb's missing-row behavior. */
function BlendTileAttributionRow({ tileIds }: { tileIds: string[] }) {
  // Build a flat map of tile id → thumbKey from the current source's
  // iterations.
  //
  // Selector hygiene (v3.6 — corrected from v3.5):
  //
  // The naive `useCanvas((s) => new Map(...))` would return a fresh
  // Map every store update (zustand uses Object.is by default) → this
  // component re-renders on EVERY mutation in the store.
  //
  // v3.5 tried to fix that with `useShallow` over an array of
  // `[id, thumbKey] as const` tuples — but zustand's `shallow`
  // compares each ARRAY ELEMENT with Object.is. Each tuple is a
  // freshly-allocated object on every selector run, so Object.is
  // returns false → shallow comparison fails → re-render still
  // fires. Same wart, just hidden.
  //
  // v3.6: project to PRIMITIVES — a flat `string[]` of joined
  // `"id|thumbKey"` strings. shallow's per-element Object.is works on
  // strings (interned), so the comparison correctly says "same" when
  // no tile actually changed. Then split inside the useMemo to build
  // the Map. The `` delimiter (a control character) is unused
  // in any ulid + R2 key, so splitting is unambiguous even if the
  // thumbKey contains pipes.
  const tilePairs = useCanvas(
    useShallow((s) =>
      s.iterations.flatMap((it) =>
        it.tiles.map((t) => `${t.id}${t.thumbKey ?? ""}`),
      ),
    ),
  );
  const tileThumbByIdMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const pair of tilePairs) {
      const sep = pair.indexOf("");
      const id = pair.slice(0, sep);
      const thumb = pair.slice(sep + 1);
      m.set(id, thumb === "" ? null : thumb);
    }
    return m;
  }, [tilePairs]);
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-1"
      aria-label="Blend input tiles"
    >
      <span className="caption-display text-xs uppercase tracking-[0.18em] text-text-mute">
        Blend of
      </span>
      <div className="flex flex-wrap gap-2">
        {tileIds.map((tid, idx) => (
          <BlendInputTileThumb
            key={tid}
            tileId={tid}
            thumbKey={tileThumbByIdMap.get(tid) ?? null}
            ordinal={idx + 1}
          />
        ))}
      </div>
    </div>
  );
}

// v4.4: module-scoped cache for cross-source blend-input thumb lookups.
// One GET /api/tiles/:id per unknown tile id per tab session — every
// BlendInputTileThumb instance for the same id shares the promise. A 404
// (deleted input) caches as null → "?" placeholder, correctly, forever.
const crossSourceTileThumbCache = new Map<string, Promise<string | null>>();

function fetchTileThumbKey(tileId: string): Promise<string | null> {
  let p = crossSourceTileThumbCache.get(tileId);
  if (!p) {
    p = (async () => {
      try {
        const resp = await authFetch(
          `/api/tiles/${encodeURIComponent(tileId)}`,
          withTimeout({}, TIMEOUT_JSON_MS),
        );
        // v4.6: only a true 404 (tile deleted) caches as null forever.
        // Transient failures (401 blip, 5xx, offline) drop the cache
        // entry so the next mount retries — pre-v4.6 they poisoned the
        // id with a permanent "?" placeholder for the whole tab
        // session.
        if (resp.status === 404) return null;
        if (!resp.ok) {
          crossSourceTileThumbCache.delete(tileId);
          return null;
        }
        const data = (await resp.json()) as { thumbKey?: string | null };
        return data.thumbKey ?? null;
      } catch {
        crossSourceTileThumbCache.delete(tileId);
        return null;
      }
    })();
    crossSourceTileThumbCache.set(tileId, p);
  }
  return p;
}

function BlendInputTileThumb({
  tileId,
  thumbKey,
  ordinal,
}: {
  tileId: string;
  thumbKey: string | null;
  ordinal: number;
}) {
  // v4.4: cross-source fallback. When the input tile isn't in the
  // current source's in-store iterations (thumbKey prop is null — a
  // cross-source blend input, or a since-deleted tile), resolve its
  // thumbKey via GET /api/tiles/:id (module-cached above). Store-
  // provided thumbKey wins when present; deleted tiles resolve to
  // null and keep the "?" placeholder.
  const [fetchedThumbKey, setFetchedThumbKey] = useState<string | null>(null);
  useEffect(() => {
    if (thumbKey !== null) return;
    let alive = true;
    void fetchTileThumbKey(tileId).then((k) => {
      if (alive && k !== null) setFetchedThumbKey(k);
    });
    return () => {
      alive = false;
    };
  }, [tileId, thumbKey]);
  const effectiveThumbKey = thumbKey ?? fetchedThumbKey;
  // useImageUrl tolerates null cleanly → no errant signed-URL fetch
  // when the input tile isn't resolvable (deleted input).
  const { url } = useImageUrl(effectiveThumbKey);
  if (effectiveThumbKey === null || !url) {
    return (
      <div
        className="flex h-9 w-9 items-center justify-center rounded-sm ring-1 ring-hairline/50 bg-secondary"
        title={`Blend input #${ordinal} — tile unavailable (${tileId.slice(0, 8)}…)`}
        aria-label="Tile unavailable"
      >
        <span className="caption-display text-[10px] italic text-text-mute/70">
          ?
        </span>
      </div>
    );
  }
  return (
    <div
      className="relative h-9 w-9 shrink-0 overflow-hidden rounded-sm ring-1 ring-hairline/50"
      title={`Blend input #${ordinal}`}
    >
      <img
        src={url}
        alt={`Blend input ${ordinal}`}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </div>
  );
}
