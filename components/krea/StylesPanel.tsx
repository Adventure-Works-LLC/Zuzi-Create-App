"use client";

/**
 * StylesPanel — slide-in drawer from the right showing Zuzi's style
 * reference library, with per-card long-press → ActionMenu "Delete
 * forever" + a header Choose button for adding more paintings (file
 * picker, multi-select). v2.1 surfaces only the active set (archive UI
 * deferred to v0.2 per the plan).
 *
 * Pattern mirrors ArchivedSourcesPanel + FavoritesPanel:
 *   - z-40 (Lightbox sits at z-50 above).
 *   - Esc to close, deferring to Lightbox if one is open.
 *   - Tap-outside (the scrim) closes.
 *
 * Differences from the source-side drawers:
 *   - Grid layout (2/3/4 cols responsive) instead of a list, because
 *     paintings are visually scannable and Zuzi's mental model is "scan
 *     the wall" not "scan a queue".
 *   - Hydrates from useStylePaintings on mount (NOT lazy-on-open) — the
 *     same store slice will be read by the future ExploreSheet, so we
 *     want the data warm regardless of whether the drawer is open.
 *   - Long-press → ActionMenu "Delete forever" (single item; no archive
 *     in UI yet). window.confirm is the destructive guardrail, matching
 *     SourceStrip's source-delete pattern exactly.
 *   - Empty state has a Choose CTA front-and-center, because a brand-new
 *     library is the most likely empty-state and the user's next move is
 *     "add some" rather than "wait for sync".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Layers, Loader2, Trash2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useIterations } from "@/hooks/useIterations";
import { useStylePaintings } from "@/hooks/useStylePaintings";
import { useCanvas, type StylePainting } from "@/stores/canvas";
import { pricePerImage } from "@/lib/cost";
import {
  MAX_BLEND_STYLES,
  TILE_COUNT_DEFAULT,
} from "@/lib/gemini/imagePrompts";
import { ActionMenu } from "./ActionMenu";

// Match SourceStrip's long-press constants so the gesture feels identical
// across the two surfaces. iOS native long-press is ~500ms; 450 fires just
// before Safari's callout/magnifier so we don't double-up the gesture.
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE = 10;

/** One painting in the grid — square thumbnail + optional title caption
 *  underneath. Long-press opens an ActionMenu anchored to the thumb. The
 *  card owns its own busy/error state so a slow Delete on one card
 *  doesn't freeze the rest of the grid.
 *
 *  v3.0 blend mode: when `blendMode` is true, the card swaps to a
 *  selection affordance:
 *    - Tap toggles selection (single-tap to select, second tap to
 *      deselect — matches the gesture pattern from the UX agent).
 *    - Selected cards show a brass ring + numbered badge ("1", "2", …)
 *      indicating selection order.
 *    - Long-press is disabled (no delete from blend mode — keeps the
 *      cap-conscious operation surface explicit).
 *  In non-blend mode (default), the card behaves as before: tap is a
 *  no-op, long-press opens the delete ActionMenu.
 */
function StylePaintingCard({
  row,
  onDelete,
  blendMode,
  selectionIndex,
  onToggleSelect,
  selectionDisabledReason,
}: {
  row: StylePainting;
  onDelete: () => Promise<void>;
  /** True when the panel is in blend-selection mode. */
  blendMode: boolean;
  /** 1-based position in the selection order, or null if not selected.
   *  Renders as the badge number on the thumb. */
  selectionIndex: number | null;
  /** Toggle the selection state of this card. The caller enforces the
   *  cap + dedup; this card just signals user intent. */
  onToggleSelect: () => void;
  /** When non-null, the card is selectable=false (e.g. cap reached and
   *  this card isn't already selected). Renders a dimmed look + the
   *  reason as a hover title. */
  selectionDisabledReason: string | null;
}) {
  const { url } = useImageUrl(row.inputKey);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  // (No longPressFiredRef here — the StylesPanel card has no tap
  // action in v2.x, so there's no click-after-long-press to suppress.
  // Compare with SourceStrip's SourceThumb which DOES need this ref
  // because tap = setCurrentSource. Add the ref back if a v0.2 tap
  // action lands.)
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captionText = useMemo(() => {
    if (row.title) return row.title;
    if (row.originalFilename)
      // Strip extension for a cleaner caption when no explicit title.
      return row.originalFilename.replace(/\.[^.]+$/, "");
    return "Untitled";
  }, [row.title, row.originalFilename]);

  const cancelTimer = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setMenuOpen(true);
  };

  const startPress = (e: React.PointerEvent) => {
    // Long-press → delete menu is suppressed in blend mode. The selection
    // gesture (tap) owns the surface there; mixing in a delete shortcut
    // would make the cap-conscious operation feel destructive-adjacent.
    if (blendMode) return;
    startPosRef.current = { x: e.clientX, y: e.clientY };
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
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
      cancelTimer();
    }
  };
  const endPress = () => {
    cancelTimer();
    startPosRef.current = null;
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    // window.confirm is the destructive guardrail. Matches SourceStrip
    // and ArchivedSourcesPanel exactly so the user's mental model of
    // "long-press → menu → confirm" works the same everywhere.
    const ok = window.confirm(
      "This permanently deletes this style painting.\nAny tiles generated against it stay, but their style attribution disappears. Delete?",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isSelected = selectionIndex !== null;
  // The selection badge sits at top-right of the thumb. Brass ring
  // mirrors the SourceStrip's current-source ring (`ring-accent`) so
  // the visual vocabulary stays consistent.
  const ringClasses = isSelected
    ? "ring-2 ring-accent"
    : blendMode && selectionDisabledReason
      ? "ring-1 ring-hairline/30"
      : "ring-1 ring-hairline/50 hover:ring-hairline";

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!blendMode) return; // non-blend: tap is intentionally a no-op
    if (!isSelected && selectionDisabledReason) return; // capped + not already selected
    onToggleSelect();
  };

  return (
    <li className="flex flex-col gap-2">
      <button
        ref={buttonRef}
        type="button"
        onPointerDown={startPress}
        onPointerMove={onMove}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onClick={handleClick}
        onContextMenu={(e) => e.preventDefault()}
        style={{ touchAction: "manipulation" }}
        className={[
          "relative aspect-square w-full overflow-hidden rounded-md transition-all",
          ringClasses,
          "no-callout",
          busy && "opacity-60 cursor-wait",
          blendMode && !isSelected && selectionDisabledReason
            ? "opacity-40 cursor-not-allowed"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={
          blendMode
            ? isSelected
              ? `Selected: ${captionText} (position ${selectionIndex})`
              : selectionDisabledReason
                ? `${captionText} (${selectionDisabledReason})`
                : `Select for blend: ${captionText}`
            : `Style painting: ${captionText}`
        }
        aria-pressed={blendMode ? isSelected : undefined}
        title={
          blendMode && !isSelected && selectionDisabledReason
            ? selectionDisabledReason
            : undefined
        }
        disabled={busy}
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
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2
              className="h-5 w-5 animate-spin text-foreground"
              strokeWidth={1.75}
            />
          </div>
        )}
        {/* Selection badge — only in blend mode + when selected. Brass
            ring + filled circle in accent color, white numeral. Top-
            right placement mirrors a checkmark affordance the eye scans
            for during multi-select. */}
        {blendMode && isSelected && (
          <div
            className={[
              "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center",
              "rounded-full bg-accent text-accent-foreground",
              "text-xs font-medium tabular-nums",
              "ring-2 ring-background",
              "shadow-sm",
            ].join(" ")}
            aria-hidden
          >
            {selectionIndex}
          </div>
        )}
      </button>
      <p className="caption-display truncate px-1 text-xs text-text-mute">
        {captionText}
      </p>
      {error && (
        <p className="px-1 text-xs text-destructive">{error}</p>
      )}
      {menuOpen && menuPos && (
        <ActionMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          position={{ top: menuPos.top, left: menuPos.left }}
          ariaLabel="Style painting actions"
          items={[
            {
              id: "delete-forever",
              label: "Delete forever",
              icon: <Trash2 className="h-4 w-4" strokeWidth={1.75} />,
              destructive: true,
              onSelect: () => {
                void handleDelete();
              },
            },
          ]}
        />
      )}
    </li>
  );
}

export function StylesPanel() {
  const open = useCanvas((s) => s.stylesPanelOpen);
  const setOpen = useCanvas((s) => s.setStylesPanelOpen);
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);
  const rows = useCanvas((s) => s.stylePaintings);
  // v3.0 blend-mode tier inheritance: take the current InputBar tier
  // (Pro default), per the UX agent's "drill is a stream-level commit"
  // rationale. ExploreSheet's local Flash default doesn't apply here.
  const modelTier = useCanvas((s) => s.modelTier);

  const { loading, error, uploading, uploadFile, deleteForever } =
    useStylePaintings();
  const { generate } = useIterations();

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // v3.0 Blend mode state — local to the panel. Selection order is
  // preserved (array, not Set) because the order maps to the parts
  // array sent to Gemini; future iterations of the blend directive may
  // use slot-based language so the order needs to stay user-controlled.
  const [blendMode, setBlendMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [blendInFlight, setBlendInFlight] = useState(false);
  const [blendError, setBlendError] = useState<string | null>(null);

  // Esc-to-close. Same lightbox-deference pattern as FavoritesPanel +
  // ArchivedSourcesPanel: if a lightbox is open in either mode, let its
  // handler consume the Esc. In blend mode, Esc exits blend mode first
  // instead of closing the panel — gives the user a less-destructive
  // out from an accidental blend-mode entry.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key !== "Escape") return;
      if (blendMode) {
        setBlendMode(false);
        setSelectedIds([]);
        setBlendError(null);
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot, blendMode]);

  // Auto-clear transient upload errors so the header doesn't get stuck.
  useEffect(() => {
    if (!uploadError) return;
    const t = window.setTimeout(() => setUploadError(null), 4000);
    return () => window.clearTimeout(t);
  }, [uploadError]);

  // Reset blend selection when the library list changes underneath us
  // (e.g., a delete removed a selected style; an upload added a new
  // one). Drop any selected ids that are no longer in the library so
  // the action bar never tries to blend a ghost id.
  useEffect(() => {
    setSelectedIds((prev) => {
      const valid = new Set(rows.map((r) => r.id));
      const next = prev.filter((id) => valid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [rows]);

  // Reset blend state whenever the panel closes so the next open is
  // clean (no stale selection persisting across opens).
  useEffect(() => {
    if (!open) {
      setBlendMode(false);
      setSelectedIds([]);
      setBlendError(null);
      setBlendInFlight(false);
    }
  }, [open]);

  if (!open) return null;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Parallel upload of all selected files. authFetch dedupes 401
    // refresh storms; individual failures surface as a header banner
    // (we only show the first; subsequent failures are logged).
    const tasks = Array.from(files).map((f) => uploadFile(f));
    const results = await Promise.allSettled(tasks);
    const firstFailure = results.find((r) => r.status === "rejected");
    if (firstFailure && firstFailure.status === "rejected") {
      setUploadError(
        firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : String(firstFailure.reason),
      );
    }
  };

  // ---- v3.0 blend-mode helpers ----

  const handleToggleSelect = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const at = prev.indexOf(id);
        if (at >= 0) {
          // Deselect: remove the id; remaining selection re-numbers
          // automatically since the badge reads from the array index.
          return prev.filter((x) => x !== id);
        }
        if (prev.length >= MAX_BLEND_STYLES) return prev; // capped — no-op
        return [...prev, id];
      });
    },
    [],
  );

  const handleEnterBlendMode = () => {
    setBlendMode(true);
    setBlendError(null);
  };

  const handleExitBlendMode = () => {
    setBlendMode(false);
    setSelectedIds([]);
    setBlendError(null);
  };

  const handleFireBlend = async () => {
    if (blendInFlight) return;
    if (selectedIds.length < 2) return;
    setBlendInFlight(true);
    setBlendError(null);
    try {
      const result = await generate({
        mode: "style_blend",
        blendStylePaintingIds: selectedIds,
        // Tier inherits from the InputBar (modelTier from canvas store).
        // Resolution is locked to 1K for v3.0 — blend's cost surface
        // is already higher (multi-image input); 4K is opt-in via a
        // future per-iteration upgrade flow.
        modelTier,
        resolution: "1k",
      });
      if (!result) {
        setBlendError(
          "Couldn't start the blend — check the input bar for the error.",
        );
        return;
      }
      // Land back in Studio watching the new iteration arrive. Exit
      // blend mode + close the panel.
      handleExitBlendMode();
      setOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBlendError(`Couldn't blend — ${msg}`);
    } finally {
      setBlendInFlight(false);
    }
  };

  // Per-tile cost preview. count × pricePerImage(tier, '1k'). The
  // actual call is one Gemini request per tile with multi-image input —
  // pricePerImage in lib/cost.ts is per output image so this is the
  // floor; real cost may run slightly higher per Gemini's multi-image
  // input pricing. Treat this as an approximation; the cap check is
  // server-authoritative.
  const blendCostUsd =
    pricePerImage(modelTier, "1k") * TILE_COUNT_DEFAULT;
  const selectionCount = selectedIds.length;
  const atCap = selectionCount >= MAX_BLEND_STYLES;
  const canFire = selectionCount >= 2 && !blendInFlight;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Style library"
      className="fixed inset-0 z-40 flex"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="flex-1 bg-black/40" />
      <aside
        className={[
          "h-dvh w-full max-w-[640px] shrink-0",
          "bg-background border-l border-hairline",
          "flex flex-col",
        ].join(" ")}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-5 py-4">
          <h2 className="flex-1 font-display text-2xl tracking-tight text-foreground">
            {blendMode ? "Pick styles to blend" : "Style library"}
          </h2>
          {/* v3.0: Blend toggle. Available whenever the library has at
              least 2 paintings (one isn't enough to blend; an empty
              library has no Blend affordance to show). The button
              flips both the panel's mode + acts as the cancel when
              blend mode is on (handleExitBlendMode). */}
          {rows.length >= 2 && (
            <button
              type="button"
              onClick={
                blendMode ? handleExitBlendMode : handleEnterBlendMode
              }
              disabled={blendInFlight}
              className={[
                "flex items-center gap-2 rounded-md px-3 py-2",
                "border text-sm transition-colors no-callout",
                blendMode
                  ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/20"
                  : "border-hairline/60 bg-card text-foreground hover:bg-secondary",
                "disabled:opacity-50 disabled:cursor-wait",
              ].join(" ")}
              aria-label={blendMode ? "Exit blend mode" : "Enter blend mode"}
              aria-pressed={blendMode}
            >
              <Layers className="h-4 w-4" strokeWidth={1.75} />
              <span>{blendMode ? "Cancel" : "Blend"}</span>
            </button>
          )}
          {/* Add is hidden during blend mode — the surface is focused
              on the selection task; uploads would dilute attention.
              Exit blend mode to upload more styles. */}
          {!blendMode && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={[
                "flex items-center gap-2 rounded-md px-3 py-2",
                "border border-hairline/60 bg-card",
                "text-sm text-foreground hover:bg-secondary",
                "transition-colors no-callout",
                "disabled:opacity-50 disabled:cursor-wait",
              ].join(" ")}
              aria-label="Add style paintings"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
              ) : (
                <ImagePlus className="h-4 w-4" strokeWidth={1.75} />
              )}
              <span>{uploading ? "Adding…" : "Add"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={blendInFlight}
            className={[
              "rounded-full p-2 transition-colors no-callout",
              blendInFlight
                ? "text-text-mute/40 cursor-wait"
                : "text-text-mute hover:text-foreground hover:bg-secondary",
            ].join(" ")}
            aria-label="Close style library"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </header>

        {uploadError && (
          <p className="border-b border-hairline/60 bg-destructive/5 px-5 py-2 text-xs text-destructive">
            {uploadError}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {loading && rows.length === 0 && (
            <div className="flex items-center justify-center py-20 text-text-mute">
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
            </div>
          )}
          {error && !loading && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && rows.length === 0 && (
            // Empty state: front-and-center CTA. The wording follows the
            // plan's "Drop paintings here to start a style library." brief
            // but the actual interaction is file-picker (drop-drop lands
            // in v0.2). The Choose button is the same handler as the
            // header's Add button — one tap, file picker opens.
            <div className="flex flex-col items-center gap-4 py-20 text-center">
              <p className="font-display text-lg italic text-text-mute">
                Drop paintings here to start a style library.
              </p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={[
                  "rounded-md px-4 py-2",
                  "border border-accent/60 bg-accent/10",
                  "text-sm font-medium text-accent hover:bg-accent/15",
                  "transition-colors no-callout",
                ].join(" ")}
              >
                Choose images
              </button>
            </div>
          )}
          {rows.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {rows.map((row) => {
                const sel = selectedIds.indexOf(row.id);
                const selectionIndex = sel >= 0 ? sel + 1 : null;
                const selectionDisabledReason =
                  blendMode && sel < 0 && atCap
                    ? `Pick at most ${MAX_BLEND_STYLES} styles`
                    : null;
                return (
                  <StylePaintingCard
                    key={row.id}
                    row={row}
                    onDelete={() => deleteForever(row.id)}
                    blendMode={blendMode}
                    selectionIndex={selectionIndex}
                    onToggleSelect={() => handleToggleSelect(row.id)}
                    selectionDisabledReason={selectionDisabledReason}
                  />
                );
              })}
            </ul>
          )}
        </div>

        {/* v3.0 blend action bar — slides up from the bottom when blend
            mode is active. Shows live selection count + cost preview +
            the fire button. Disabled until 2+ selected. */}
        {blendMode && (
          <footer
            className={[
              "border-t border-hairline bg-background",
              "flex flex-wrap items-center gap-3 px-5 py-4",
            ].join(" ")}
          >
            <div className="flex flex-1 flex-col">
              <p className="text-sm tabular-nums text-foreground">
                <span className="font-medium">{selectionCount}</span>{" "}
                {selectionCount === 1 ? "style" : "styles"} selected
                {atCap && (
                  <span className="ml-1 text-text-mute">
                    (max {MAX_BLEND_STYLES})
                  </span>
                )}
              </p>
              <p className="caption-display text-xs text-text-mute">
                {selectionCount < 2
                  ? `Pick at least 2 styles to blend.`
                  : `Will spend up to $${blendCostUsd.toFixed(2)} (${TILE_COUNT_DEFAULT} × ${
                      modelTier === "flash" ? "Flash" : "Pro"
                    } 1K).`}
              </p>
              {blendError && (
                <p className="mt-1 text-xs text-destructive">{blendError}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleFireBlend()}
              disabled={!canFire}
              className={[
                "inline-flex items-center gap-2 rounded-full",
                "px-5 py-2 text-sm font-medium no-callout",
                "bg-accent text-accent-foreground",
                "transition-opacity",
                !canFire ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
              ].join(" ")}
            >
              {blendInFlight ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                  Blending…
                </>
              ) : (
                <>
                  <Layers className="h-4 w-4" strokeWidth={1.5} />
                  Blend {selectionCount > 0 ? selectionCount : ""}
                </>
              )}
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}
