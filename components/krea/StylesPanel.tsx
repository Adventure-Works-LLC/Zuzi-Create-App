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

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2, UserRound, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useIterations } from "@/hooks/useIterations";
import { useStylePaintings } from "@/hooks/useStylePaintings";
import { costFor } from "@/lib/cost";
import { TILE_COUNT_DEFAULT } from "@/lib/gemini/imagePrompts";
import { useCanvas, type StylePainting } from "@/stores/canvas";
import { ActionMenu } from "./ActionMenu";

// Match SourceStrip's long-press constants so the gesture feels identical
// across the two surfaces. iOS native long-press is ~500ms; 450 fires just
// before Safari's callout/magnifier so we don't double-up the gesture.
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE = 10;

// v4.0: sentinel for the "Untagged" filter chip. Uses a control char so
// no real artist name typed through window.prompt can collide with it.
const UNTAGGED_FILTER = "\u0000__untagged__";

/** One pill in the artist filter row. Module-level, hook-free — safe to
 *  render conditionally. Styling matches the app's chip register
 *  (rounded-full hairline pills; accent tint when selected). */
function FilterChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs",
        "transition-colors no-callout",
        selected
          ? "border-accent/60 bg-accent/15 text-accent font-medium"
          : "border-hairline/60 text-text-mute hover:text-foreground hover:border-hairline",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/** One painting in the grid — square thumbnail + optional title caption
 *  underneath. Long-press opens an ActionMenu anchored to the thumb (the
 *  delete-forever destructive path). Tap fires a single-style Explore
 *  iteration against the current source (v3.7 — see onFire prop). The
 *  card owns its own busy/error state so a slow operation on one card
 *  doesn't freeze the rest of the grid. */
function StylePaintingCard({
  row,
  onDelete,
  onSetArtist,
  onArm,
  onFire,
  isArmed,
  fireDisabled,
  fireDisabledReason,
  submitCostUsd,
}: {
  row: StylePainting;
  onDelete: () => Promise<void>;
  /** v4.0: persist a new artist value (null clears). The card owns the
   *  window.prompt flow; the panel owns the PATCH + store update. */
  onSetArtist: (artist: string | null) => Promise<void>;
  /** v3.8: arm this card (first tap). Panel-level state tracks which
   *  card is armed; only one at a time. Tapping a different card
   *  re-arms; tapping the same card again calls onFire. */
  onArm: () => void;
  /** Called on the SECOND tap of an armed card. Resolves when the
   *  iteration POST returns + the panel will close. Throws on error
   *  (caller surfaces inline). */
  onFire: () => Promise<void>;
  /** True when this card is the panel's currently-armed card.
   *  Drives the visual treatment + the tap-to-fire vs tap-to-arm
   *  branch in handleTap. */
  isArmed: boolean;
  /** When true, taps are no-ops + the card renders disabled. Reasons:
   *  no current source, another fire already in-flight. */
  fireDisabled: boolean;
  /** Tooltip / aria text explaining why the tap is disabled. */
  fireDisabledReason?: string;
  /** v3.9: projected USD cost of the iteration that fires on tap-again.
   *  Computed at the panel level from current modelTier × 1k × default
   *  tile count. Surfaced in the armed-card caption so the user sees the
   *  cost number at confirmation time (cap-aware Submit shouldn't be the
   *  only place she sees the spend). */
  submitCostUsd: number;
}) {
  const { url } = useImageUrl(row.inputKey);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  // v3.7: re-added after the v2.7 → v3.0 → v3.4 path landed tap-to-fire.
  // Once a long-press fires (menu opens at 450ms), the subsequent
  // pointerup → click bubble must NOT also trigger the fire handler.
  // Mirrors SourceStrip's SourceThumb gesture pattern.
  const longPressFiredRef = useRef(false);
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
      cancelTimer();
    }
  };
  const endPress = () => {
    cancelTimer();
    startPosRef.current = null;
  };

  // v3.7+v3.8: tap handler with two-tap confirmation.
  // Skips when long-press fired (menu opened; the pointerup → click
  // bubble would otherwise also fire the action). Skips when the card
  // is disabled (no source, another fire already in-flight). When
  // armed, second tap calls onFire; otherwise first tap calls onArm.
  // The async onFire is awaited here so a slow R2 + DB roundtrip
  // surfaces visibly via setBusy + inline error.
  //
  // Rationale for two-tap: with single-tap-fires, a stray finger
  // during scroll could fire a $0.40 Gemini call. Two-tap means a
  // misfire requires two intentional taps on the same card within
  // the 4s arm window (set + cleared at the panel level) — much
  // less likely to happen by accident.
  const handleTap = async () => {
    if (longPressFiredRef.current) return;
    if (fireDisabled || busy) return;
    // v3.9: clear any prior error before the next arm/fire. Without
    // this, a failed fire leaves the red text under the card until
    // panel close — which then survives across tap-arm-on-different-
    // card. Tapping anywhere should clean the slate visually.
    setError(null);
    if (!isArmed) {
      onArm();
      return;
    }
    setBusy(true);
    try {
      await onFire();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // v4.0: long-press → "Set artist…". window.prompt keeps the zero-new-
  // components dialog register the panel already uses for destructive
  // confirms. Blank input clears the artist (null); Cancel is a no-op.
  const handleSetArtist = async () => {
    setMenuOpen(false);
    const input = window.prompt(
      "Artist name for this painting (blank to clear):",
      row.artist ?? "",
    );
    if (input === null) return; // cancelled
    const artist = input.trim() || null;
    if (artist === (row.artist ?? null)) return; // no change
    setBusy(true);
    setError(null);
    try {
      await onSetArtist(artist);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
        // v3.7+v3.8: two-tap confirmation. First tap → arms the card
        // (visual brass ring + caption swap). Second tap on the
        // same card → fires. handleTap is async-safe (awaits +
        // catches); the panel-level onFire prop closes the panel
        // on success + the panel-level onArm tracks armedCardId.
        onClick={() => void handleTap()}
        onContextMenu={(e) => e.preventDefault()}
        style={{ touchAction: "manipulation" }}
        className={[
          "relative aspect-square w-full overflow-hidden rounded-md",
          "transition-all",
          fireDisabled
            ? "ring-1 ring-hairline/30 cursor-not-allowed opacity-60"
            : isArmed
              ? "ring-4 ring-accent cursor-pointer"
              : "ring-1 ring-hairline/50 hover:ring-accent/60 cursor-pointer",
          "no-callout",
          busy && "opacity-60 cursor-wait",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={
          fireDisabled
            ? `Style painting: ${captionText} (${fireDisabledReason ?? "tap disabled"})`
            : isArmed
              ? `Tap again to generate current source in style: ${captionText} (approximately $${submitCostUsd.toFixed(2)} USD)`
              : `Select style: ${captionText} (tap again to generate)`
        }
        aria-pressed={isArmed ? true : undefined}
        title={fireDisabled ? fireDisabledReason : undefined}
        disabled={busy || fireDisabled}
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
      </button>
      <p
        className={[
          "caption-display truncate px-1 text-xs",
          // v3.8: swap caption to confirmation hint when armed —
          // accent color + non-italic to read as a call-to-action,
          // not a styled label. Truncation still applies in case
          // the hint text would wrap the row's clamp.
          // v3.9: surface the cost number at confirmation time. The
          // "Tap again · $X.XX" format mirrors the InputBar's cost-
          // annotation convention. Keeping the verb short ("Tap
          // again") leaves headroom for the cost at 218px card width.
          isArmed ? "text-accent font-medium" : "text-text-mute",
        ].join(" ")}
      >
        {isArmed
          ? `Tap again · $${submitCostUsd.toFixed(2)}`
          : captionText}
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
              id: "set-artist",
              label: row.artist ? `Artist: ${row.artist}` : "Set artist…",
              icon: <UserRound className="h-4 w-4" strokeWidth={1.75} />,
              onSelect: () => {
                void handleSetArtist();
              },
            },
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
  // v3.7 tap-to-fire: gates on having a current source. Without one
  // (cold start / archived all sources) the cards render disabled
  // because generate() needs a sourceId.
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  // v3.9: modelTier feeds the per-card cost preview. Resolution is
  // always 1k for style_explore (the panel doesn't expose a res
  // toggle), and count is TILE_COUNT_DEFAULT (3) — same as the rest
  // of the system. Pro 1K × 3 = $0.40; Flash 1K × 3 = $0.20.
  const modelTier = useCanvas((s) => s.modelTier);

  const { loading, error, uploading, uploadFile, setArtist, deleteForever } =
    useStylePaintings();
  const { generate } = useIterations();
  // Panel-level in-flight: only one tap-to-fire at a time across the
  // grid. Without this gate, rapid taps on multiple cards would queue
  // multiple iterations + race the panel-close (the second tap would
  // fire after the first closes the panel, leaving an orphan generate).
  const [fireInFlight, setFireInFlight] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // v3.8: which card (if any) is currently armed for fire on the next
  // tap. Only one card armed at a time across the grid — tapping a
  // different card re-arms. 4-second auto-disarm so a stray tap
  // doesn't sit hot indefinitely (next effect handles that).
  const [armedCardId, setArmedCardId] = useState<string | null>(null);
  // v4.0: artist filter. null = All; UNTAGGED_FILTER = rows without an
  // artist; any other string = exact artist match. Persists across
  // panel close/reopen within the session (deliberate — she'll usually
  // come back wanting the same artist's wall).
  const [artistFilter, setArtistFilter] = useState<string | null>(null);

  // Esc-to-close. Same lightbox-deference pattern as FavoritesPanel +
  // ArchivedSourcesPanel: if a lightbox is open in either mode, let its
  // handler consume the Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot]);

  // Auto-clear transient upload errors so the header doesn't get stuck.
  useEffect(() => {
    if (!uploadError) return;
    const t = window.setTimeout(() => setUploadError(null), 4000);
    return () => window.clearTimeout(t);
  }, [uploadError]);

  // v3.8: auto-disarm after 4 seconds. A card armed but never
  // confirmed shouldn't stay hot — the user may have moved on,
  // closed an adjacent panel, or just changed their mind. The
  // timeout is generous enough to confirm without rushing but
  // short enough that a stale armed state can't fire on a
  // significantly-later stray tap.
  useEffect(() => {
    if (armedCardId === null) return;
    const t = window.setTimeout(() => setArmedCardId(null), 4000);
    return () => window.clearTimeout(t);
  }, [armedCardId]);

  // v3.8: auto-disarm when the panel closes. Without this a quickly-
  // closed-then-reopened panel could resurrect a stale armed state
  // (state survives across the early-return-null because StylesPanel
  // stays mounted from page.tsx; only the JSX returns null).
  useEffect(() => {
    if (!open) setArmedCardId(null);
  }, [open]);

  // v3.8: auto-disarm when the current source changes. The fire
  // handler reads currentSourceId from the canvas store; if she
  // armed a card under source A and switched to source B before
  // confirming, the second tap would fire against source B —
  // surprising. Wipe the armed state on source change.
  useEffect(() => {
    setArmedCardId(null);
  }, [currentSourceId]);

  // v4.0: auto-disarm when the artist filter changes. An armed card can
  // get filtered out of the grid mid-arm; nothing breaks if it does (a
  // hidden card can't receive the confirming tap and the 4s timer wipes
  // it), but clearing immediately keeps the visible state honest —
  // switching walls reads as a context change, same as switching
  // sources.
  useEffect(() => {
    setArmedCardId(null);
  }, [artistFilter]);

  if (!open) return null;

  // v3.9: projected cost per fire. Computed AFTER the early return —
  // it's a derived value, not a hook, so the early-return-before-hook
  // rule doesn't apply. Recomputing on every render is cheap (one
  // multiplication via lib/cost.ts).
  const submitCostUsd = costFor(modelTier, "1k", TILE_COUNT_DEFAULT);

  // v4.0: artist filter derivation. Plain derived values (no hooks) so
  // they can live after the early return. Counts feed the chip labels;
  // `effectiveFilter` degrades a stale selection (artist renamed away /
  // last row deleted) back to All instead of stranding an empty grid.
  const artistCounts = new Map<string, number>();
  let untaggedCount = 0;
  for (const r of rows) {
    const a = r.artist?.trim();
    if (a) artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
    else untaggedCount++;
  }
  const artists = [...artistCounts.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  const effectiveFilter =
    artistFilter === null
      ? null
      : artistFilter === UNTAGGED_FILTER
        ? untaggedCount > 0
          ? UNTAGGED_FILTER
          : null
        : artistCounts.has(artistFilter)
          ? artistFilter
          : null;
  const visibleRows =
    effectiveFilter === null
      ? rows
      : effectiveFilter === UNTAGGED_FILTER
        ? rows.filter((r) => !r.artist?.trim())
        : rows.filter((r) => r.artist?.trim() === effectiveFilter);

  // v3.7: tap-to-fire handler. Spins a single-style Explore iteration
  // against the current source using THIS card's style id, then closes
  // the panel so the user lands back in Studio watching the new tiles
  // arrive. 3 tiles (TILE_COUNT_DEFAULT) matches the "More like this"
  // Lightbox shortcut + the rest of the system. modelTier inherits
  // from the canvas store (Pro default; user can toggle in InputBar
  // before opening the panel if they want Flash).
  const handleFireStyle = async (stylePaintingId: string): Promise<void> => {
    if (fireInFlight) return;
    if (!currentSourceId) {
      // Defensive: card is disabled when no current source, so we
      // shouldn't reach this branch, but throw a clean error if we do.
      throw new Error("No current source — pick a sketch first.");
    }
    setFireInFlight(true);
    try {
      const ids = Array(TILE_COUNT_DEFAULT).fill(stylePaintingId);
      const result = await generate({
        mode: "style_explore",
        stylePaintingIds: ids,
      });
      if (!result) {
        // generate() set its own error string in useIterations; throw
        // so the card surfaces "couldn't start" inline.
        throw new Error("Couldn't start — see input bar for the error.");
      }
      // Success: close the panel. The optimistic iteration is already
      // prepended to iterations[] so the user lands in Studio with
      // the placeholders pulsing.
      setOpen(false);
    } finally {
      setFireInFlight(false);
    }
  };

  const fireDisabledReason = !currentSourceId
    ? "Pick a sketch first"
    : fireInFlight
      ? "Another tap is in flight"
      : undefined;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // v4.0: one artist prompt per batch. Prefilled with the active
    // filter (she's looking at the Scholder wall → adding more
    // Scholders is zero typing). Semantics: Cancel aborts the whole
    // upload (dialog convention — she can re-pick the files); OK with
    // a blank field uploads untagged.
    const suggested =
      effectiveFilter && effectiveFilter !== UNTAGGED_FILTER
        ? effectiveFilter
        : "";
    const artistInput = window.prompt(
      `Artist for ${files.length === 1 ? "this painting" : `these ${files.length} paintings`}? (optional — blank to skip)`,
      suggested,
    );
    if (artistInput === null) return; // cancelled → abort upload
    const batchArtist = artistInput.trim() || null;
    // Parallel upload of all selected files. authFetch dedupes 401
    // refresh storms; individual failures surface as a header banner
    // (we only show the first; subsequent failures are logged).
    const tasks = Array.from(files).map((f) => uploadFile(f, batchArtist));
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
      {/* v3.9: scrim dismiss. The outer dialog's `target===currentTarget`
          test never fires for taps on this child div, so the backdrop
          itself needs an onClick to honor the "tap-outside closes" contract
          the comment at top of the file promises. Also restores the
          v3.8 "panel close = disarm" invariant — without this, scrim-tap
          was silently swallowed and the armed card stayed hot until the
          4s timer or the X button. */}
      <div
        className="flex-1 bg-black/40"
        onClick={() => setOpen(false)}
      />
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
            Style library
          </h2>
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
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-2 text-text-mute hover:text-foreground hover:bg-secondary transition-colors no-callout"
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

        {/* v4.0: artist filter chips. Rendered only once at least one
            painting carries an artist tag — an all-untagged library
            has nothing to filter by, so the row stays out of the way
            until tagging starts. Horizontal scroll for many artists. */}
        {artists.length > 0 && (
          <div
            className="flex shrink-0 gap-2 overflow-x-auto border-b border-hairline/60 px-5 py-3"
            role="group"
            aria-label="Filter by artist"
          >
            <FilterChip
              label={`All · ${rows.length}`}
              selected={effectiveFilter === null}
              onClick={() => setArtistFilter(null)}
            />
            {artists.map((a) => (
              <FilterChip
                key={a}
                label={`${a} · ${artistCounts.get(a)}`}
                selected={effectiveFilter === a}
                onClick={() => setArtistFilter(a)}
              />
            ))}
            {untaggedCount > 0 && (
              <FilterChip
                label={`Untagged · ${untaggedCount}`}
                selected={effectiveFilter === UNTAGGED_FILTER}
                onClick={() => setArtistFilter(UNTAGGED_FILTER)}
              />
            )}
          </div>
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
              {visibleRows.map((row) => (
                <StylePaintingCard
                  key={row.id}
                  row={row}
                  onDelete={() => deleteForever(row.id)}
                  onSetArtist={(artist) => setArtist(row.id, artist)}
                  onArm={() => setArmedCardId(row.id)}
                  onFire={async () => {
                    // Clear armed state before the network roundtrip
                    // so a slow POST doesn't leave another card
                    // visibly armed. handleFireStyle will close the
                    // panel on success regardless.
                    setArmedCardId(null);
                    await handleFireStyle(row.id);
                  }}
                  isArmed={armedCardId === row.id}
                  fireDisabled={!currentSourceId || fireInFlight}
                  fireDisabledReason={fireDisabledReason}
                  submitCostUsd={submitCostUsd}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
