/**
 * Canvas store — the Studio's working state.
 *
 * Holds:
 *   - sources[] (the strip + the currently-selected one)
 *   - iterations[] for the current source, newest-first; each iteration carries its
 *     tiles (denormalised for render-friendliness; the DB is still source of truth)
 *   - input-bar settings: modelTier, resolution, presets, count
 *   - lightbox open/closed + which tile
 *   - favorites panel open/closed
 *
 * The store NEVER fetches — it's a pure mutator. Hooks (`useSources`,
 * `useIterations`, etc.) own data fetching and call mutators. SSE streaming wires
 * tile updates into the iteration's tile array via `updateTile`.
 *
 * `iterations` is scoped to `currentSourceId`. When the user switches sources we
 * call `setIterations([])` and the iteration hook refetches for the new source.
 * That keeps the rendered list bounded to a single source's history (the Krea-
 * style "stream" only shows tiles from THIS source's runs, not all sources).
 */

import { create } from "zustand";

import { TILE_COUNT_DEFAULT } from "@/lib/gemini/imagePrompts";
import type { Preset } from "@/lib/db/schema";

export interface Source {
  /** sources.id (ulid). POST /api/iterate needs this. */
  sourceId: string;
  /** R2 key (inputs/<sourceId>.jpg). Stored for /api/image-url lookups. */
  inputKey: string;
  w: number;
  h: number;
  aspectRatio: string;
  uploadedAt: number;
  archivedAt: number | null;
}

export type TileStatus = "pending" | "done" | "blocked" | "failed";

export interface Tile {
  id: string;
  iterationId: string;
  idx: number;
  status: TileStatus;
  outputKey: string | null;
  thumbKey: string | null;
  errorMessage: string | null;
  isFavorite: boolean;
  favoritedAt: number | null;
}

export type ModelTier = "flash" | "pro";
export type Resolution = "1k" | "4k";
/** Per-iteration aspect-ratio mode. 'match' uses the source's aspect ratio
 *  (default; preserves AGENTS.md §3 "output aspect == input aspect"
 *  invariant). 'flip' swaps W:H so portrait sources generate landscape
 *  outputs and vice versa (1:1 stays 1:1). Stored on the iteration so
 *  historical rows always render at their actual aspect even after the
 *  flag changes. */
export type AspectRatioMode = "match" | "flip";
export type IterationStatus = "pending" | "running" | "done" | "failed";

/** Free-floating tile + its iteration metadata, used when the lightbox is
 *  opened from outside the current source's iteration stream (FavoritesPanel
 *  cross-source view). Carries everything the Lightbox component reads. */
export interface LightboxSnapshot {
  tileId: string;
  iterationId: string;
  idx: number;
  outputKey: string | null;
  thumbKey: string | null;
  isFavorite: boolean;
  favoritedAt: number | null;
  /** From `sources.aspect_ratio` of whichever source produced the tile.
   *  Combine with `aspectRatioMode` to get the TILE's effective aspect
   *  (`mode === 'flip' ? flip(sourceAspectRatio) : sourceAspectRatio`).
   *  The promote-from-tile path on Use-as-Source re-derives aspect from
   *  the actual image bytes via sharp, so the flipped value here doesn't
   *  need to be threaded into that flow — it just informs display. */
  sourceAspectRatio: string;
  /** R2 key for the source painting that produced this tile. Threaded
   *  through from /api/favorites so the Lightbox's Compare-with-Original
   *  mode can render the source alongside the generated tile without
   *  walking back through `useCanvas.sources` (which won't contain the
   *  source if it's archived and never loaded). */
  sourceInputKey: string;
  /** Iteration's aspect-ratio mode at generation time. Required so the
   *  cross-source FavoritesPanel → Lightbox path knows whether to flip
   *  `sourceAspectRatio` for display. */
  aspectRatioMode: AspectRatioMode;
  modelTier: ModelTier;
  resolution: Resolution;
}

export interface Iteration {
  id: string;
  sourceId: string;
  modelTier: ModelTier;
  resolution: Resolution;
  /** Aspect-ratio mode at generation time. 'match' = source aspect,
   *  'flip' = mirrored. IterationRow uses this to size each tile's
   *  container correctly even when the iteration is older than the
   *  source's current aspect ratio (sources don't change theirs, but
   *  combinations of source + mode can produce tile aspects that
   *  differ from the source). */
  aspectRatioMode: AspectRatioMode;
  tileCount: number;
  presets: Preset[];
  status: IterationStatus;
  createdAt: number;
  tiles: Tile[];
}

interface CanvasState {
  // ---- sources ----
  sources: Source[];
  currentSourceId: string | null;
  /** Mirror of `useSources()` fetch lifecycle. Lifted into the store so every
   * call site (page, InputBar, SourceStrip, Lightbox) reads a single source
   * of truth — Generate must disable when ANY mounted hook is uploading. */
  sourcesLoading: boolean;
  sourcesError: string | null;
  uploading: boolean;
  setSources: (sources: Source[]) => void;
  addSource: (source: Source) => void;
  setCurrentSource: (sourceId: string | null) => void;
  archiveSource: (sourceId: string) => void;
  /**
   * Hard-delete a source from the active strip. Same store-side shape
   * as `archiveSource` (filter out, re-pick currentSourceId if needed,
   * blank iterations[] if the deleted one was current) — the only
   * difference is intent: archive is reversible (the row stays in DB
   * with `archived_at` set), removeSource is for the permanent-delete
   * path (DB row + R2 objects gone). Both paths produce the same store
   * mutation; we keep them as separate methods for code-readability and
   * so future analytics can distinguish the two flows.
   */
  removeSource: (sourceId: string) => void;
  setSourcesLoading: (v: boolean) => void;
  setSourcesError: (v: string | null) => void;
  setUploading: (v: boolean) => void;

  // ---- iterations + tiles (current source's stream) ----
  iterations: Iteration[];
  setIterations: (iterations: Iteration[]) => void;
  prependIteration: (iteration: Iteration) => void;
  updateTile: (
    iterationId: string,
    idx: number,
    patch: Partial<Tile>,
  ) => void;
  setIterationStatus: (iterationId: string, status: IterationStatus) => void;
  setTileFavorite: (
    tileId: string,
    isFavorite: boolean,
    favoritedAt: number | null,
  ) => void;
  /**
   * Remove a tile from its iteration's `tiles[]` and, if that drops the
   * iteration to zero tiles, remove the iteration row from `iterations[]`
   * as well. Used by the Tile delete flow — server side soft-deletes via
   * /api/tiles/:id; this mutator does the optimistic store-side removal.
   * Idempotent on already-removed tiles (no-op if the tile isn't found).
   */
  removeTile: (tileId: string) => void;
  /**
   * Remove an iteration row + all its tiles from the store. Used by the
   * iteration-level delete flow ("Delete this generation" in the
   * iteration's ActionMenu, including the stuck-state escape hatch).
   * The server-side hard-delete (DELETE /api/iterations/:id) cascades
   * tile rows + cleans up R2; this mutator does the optimistic
   * store-side removal. Also closes the lightbox if it was pointing
   * at any tile of the deleted iteration. Idempotent.
   */
  removeIteration: (iterationId: string) => void;

  // ---- input-bar settings ----
  modelTier: ModelTier;
  resolution: Resolution;
  /** 'match' (default) keeps tile output at the source's aspect ratio;
   *  'flip' swaps W:H. Toggled via the InputBar's "Aspect" pill. */
  aspectRatioMode: AspectRatioMode;
  presets: Preset[];
  count: number;
  setModelTier: (tier: ModelTier) => void;
  setResolution: (resolution: Resolution) => void;
  setAspectRatioMode: (mode: AspectRatioMode) => void;
  togglePreset: (preset: Preset) => void;
  /**
   * Set or clear the active preset. Mirrors the mutually-exclusive UI
   * model — `null` means freeform (empty array), a Preset value replaces
   * the array with a single-element array. The store still holds an
   * array because the API + buildPrompt + dominator routing all consume
   * arrays (legacy multi-preset rows from before the UI exclusivity
   * change can still exist in DB and must render correctly via the
   * dominator ladder). `togglePreset` stays in place for legacy / future
   * use; the InputBar uses `setPreset` exclusively under the new model.
   */
  setPreset: (preset: Preset | null) => void;
  setCount: (count: number) => void;

  // ---- lightbox ----
  // Two open-modes:
  //   1. by-id (tileId): tile is somewhere in the current source's
  //      iterations[]. Lightbox walks the array to find it. Live-updates
  //      when the iteration's state changes (favorite toggled, SSE event).
  //   2. snapshot: tile lives outside the current source's iterations[]
  //      — typically a favorite from an archived source whose iterations
  //      were never loaded. Lightbox reads the snapshot directly. Used
  //      from FavoritesPanel; the panel may be from any source (active or
  //      archived) that the user has ever favorited from.
  // Setting either clears the other; the close button clears both.
  lightboxTileId: string | null;
  lightboxSnapshot: LightboxSnapshot | null;
  setLightboxTile: (tileId: string | null) => void;
  setLightboxSnapshot: (snapshot: LightboxSnapshot | null) => void;
  /** Optimistically flip favorite state on the current snapshot (when set).
   * Hooks/useFavorites calls this so the heart in a cross-source lightbox
   * tracks state without us needing to round-trip through iterations[]. */
  setLightboxSnapshotFavorite: (isFavorite: boolean, favoritedAt: number | null) => void;

  // ---- favorites panel ----
  favoritesOpen: boolean;
  setFavoritesOpen: (open: boolean) => void;

  // ---- archived sources panel ----
  // Same lifecycle pattern as `favoritesOpen`: a UI flag toggled by the
  // SourceStrip's archive-icon button. The ArchivedSourcesPanel mounts
  // unconditionally and renders nothing when `archivedSourcesPanelOpen`
  // is false.
  archivedSourcesPanelOpen: boolean;
  setArchivedSourcesPanelOpen: (open: boolean) => void;
}

export const useCanvas = create<CanvasState>((set) => ({
  // ---- sources ----
  sources: [],
  currentSourceId: null,
  sourcesLoading: true,
  sourcesError: null,
  uploading: false,
  setSourcesLoading: (sourcesLoading) => set({ sourcesLoading }),
  setSourcesError: (sourcesError) => set({ sourcesError }),
  setUploading: (uploading) => set({ uploading }),
  setSources: (sources) =>
    set((s) => ({
      sources,
      // If our current selection is gone, clear it. If we have sources but no
      // current selection, pick the most-recent active one.
      currentSourceId: pickCurrent(s.currentSourceId, sources),
    })),
  addSource: (source) =>
    set((s) => ({
      sources: [source, ...s.sources.filter((x) => x.sourceId !== source.sourceId)],
      currentSourceId: source.sourceId,
      // New source = empty stream until the first generate fires.
      iterations: [],
      // Context shift — restore canonical input defaults so the new
      // painting starts from the always-on baseline (Background preset,
      // Match aspect). Sticky settings like modelTier / resolution / count
      // intentionally carry over since they reflect the user's working
      // tier preference, not painting-specific state.
      presets: ["background"],
      aspectRatioMode: "match",
    })),
  setCurrentSource: (sourceId) =>
    set((s) => {
      const isSwitch = sourceId !== s.currentSourceId;
      return {
        currentSourceId: sourceId,
        // Switching sources blanks the stream — the iteration hook refetches.
        iterations: isSwitch ? [] : s.iterations,
        // On an actual switch, restore the canonical input defaults — same
        // rationale as `addSource`. A no-op call (sourceId already current)
        // doesn't reset.
        presets: isSwitch ? ["background"] : s.presets,
        aspectRatioMode: isSwitch ? "match" : s.aspectRatioMode,
      };
    }),
  archiveSource: (sourceId) =>
    set((s) => {
      const remaining = s.sources.filter((x) => x.sourceId !== sourceId);
      const wasCurrent = s.currentSourceId === sourceId;
      return {
        sources: remaining,
        currentSourceId: wasCurrent ? pickCurrent(null, remaining) : s.currentSourceId,
        iterations: wasCurrent ? [] : s.iterations,
      };
    }),
  removeSource: (sourceId) =>
    set((s) => {
      // Same shape as archiveSource — see the comment on the type
      // declaration above for why this is a separate method despite
      // the same mutation logic.
      const remaining = s.sources.filter((x) => x.sourceId !== sourceId);
      const wasCurrent = s.currentSourceId === sourceId;
      return {
        sources: remaining,
        currentSourceId: wasCurrent ? pickCurrent(null, remaining) : s.currentSourceId,
        iterations: wasCurrent ? [] : s.iterations,
      };
    }),

  // ---- iterations + tiles ----
  iterations: [],
  setIterations: (iterations) => set({ iterations }),
  prependIteration: (iteration) =>
    set((s) => ({ iterations: [iteration, ...s.iterations] })),
  updateTile: (iterationId, idx, patch) =>
    set((s) => ({
      iterations: s.iterations.map((it) =>
        it.id !== iterationId
          ? it
          : {
              ...it,
              tiles: it.tiles.map((t) =>
                t.idx === idx ? { ...t, ...patch } : t,
              ),
            },
      ),
    })),
  setIterationStatus: (iterationId, status) =>
    set((s) => ({
      iterations: s.iterations.map((it) =>
        it.id === iterationId ? { ...it, status } : it,
      ),
    })),
  setTileFavorite: (tileId, isFavorite, favoritedAt) =>
    set((s) => ({
      // Scope the rebuild to ONLY the iteration that owns this tile —
      // unchanged iterations keep their object reference so memoized
      // IterationRow children short-circuit re-render. Walking every
      // iteration × tile to flip one tile rebuilt every iteration row's
      // reference, which combined with TileStream's whole-array selector
      // re-rendered every mounted IterationRow on every favorite toggle.
      iterations: s.iterations.map((it) =>
        it.tiles.some((t) => t.id === tileId)
          ? {
              ...it,
              tiles: it.tiles.map((t) =>
                t.id === tileId ? { ...t, isFavorite, favoritedAt } : t,
              ),
            }
          : it,
      ),
      // Mirror the toggle into the lightbox snapshot if it's the same tile.
      // For cross-source favorites (snapshot mode), iterations[] doesn't
      // contain this tile, so the array map above is a no-op and the heart
      // in the lightbox stays stale without this branch.
      lightboxSnapshot:
        s.lightboxSnapshot && s.lightboxSnapshot.tileId === tileId
          ? { ...s.lightboxSnapshot, isFavorite, favoritedAt }
          : s.lightboxSnapshot,
    })),
  removeTile: (tileId) =>
    set((s) => {
      // Filter the tile out of whichever iteration owns it. If filtering
      // leaves the iteration with zero tiles, drop the iteration too — the
      // user's mental model is "delete the last tile of a generation and
      // the whole generation goes away" (the row of N tiles in the stream
      // is the unit they perceive). The DB iteration row stays around for
      // backup / debugging; client-side removal is just visual.
      const nextIters = s.iterations
        .map((it) => {
          const filtered = it.tiles.filter((t) => t.id !== tileId);
          return filtered.length === it.tiles.length ? it : { ...it, tiles: filtered };
        })
        .filter((it) => it.tiles.length > 0);
      // If the deleted tile was the open lightbox target, close it. The
      // user shouldn't be left staring at a tile they just deleted.
      const lightboxTileId = s.lightboxTileId === tileId ? null : s.lightboxTileId;
      const lightboxSnapshot =
        s.lightboxSnapshot && s.lightboxSnapshot.tileId === tileId
          ? null
          : s.lightboxSnapshot;
      return {
        iterations: nextIters,
        lightboxTileId,
        lightboxSnapshot,
      };
    }),
  removeIteration: (iterationId) =>
    set((s) => {
      const target = s.iterations.find((it) => it.id === iterationId);
      const nextIters = s.iterations.filter((it) => it.id !== iterationId);
      // Close the lightbox if it was pointing at any tile of the deleted
      // iteration — covers both by-id mode (lightboxTileId in iter.tiles)
      // and snapshot mode (lightboxSnapshot.iterationId === id).
      const targetTileIds = new Set(target?.tiles.map((t) => t.id) ?? []);
      const lightboxTileId =
        s.lightboxTileId !== null && targetTileIds.has(s.lightboxTileId)
          ? null
          : s.lightboxTileId;
      const lightboxSnapshot =
        s.lightboxSnapshot && s.lightboxSnapshot.iterationId === iterationId
          ? null
          : s.lightboxSnapshot;
      return {
        iterations: nextIters,
        lightboxTileId,
        lightboxSnapshot,
      };
    }),

  // ---- input-bar settings ----
  modelTier: "pro",
  resolution: "1k",
  aspectRatioMode: "match",
  // Background is the always-on preset default. The UI never sends an
  // empty preset array to /api/iterate — buildPrompt's empty-presets
  // branch stays as a defensive fallback for legacy data + smoke
  // testing, but the canonical UI state is always exactly one preset.
  // See InputBar.tsx for the picker-open transitional behavior that
  // visually shows all four cells while preserving this invariant.
  presets: ["background"],
  count: TILE_COUNT_DEFAULT,
  setModelTier: (modelTier) => set({ modelTier }),
  setResolution: (resolution) => set({ resolution }),
  setAspectRatioMode: (aspectRatioMode) => set({ aspectRatioMode }),
  setPreset: (preset) =>
    set({ presets: preset === null ? [] : [preset] }),
  togglePreset: (preset) =>
    set((s) => ({
      presets: s.presets.includes(preset)
        ? s.presets.filter((p) => p !== preset)
        : [...s.presets, preset],
    })),
  setCount: (count) => set({ count }),

  // ---- lightbox ----
  lightboxTileId: null,
  lightboxSnapshot: null,
  // Setting either mode clears the other so we never have an ambiguous state.
  // Closing (`setLightboxTile(null)` from the close button) clears both, so
  // a snapshot opened from FavoritesPanel closes cleanly.
  setLightboxTile: (tileId) =>
    set({ lightboxTileId: tileId, lightboxSnapshot: null }),
  setLightboxSnapshot: (snapshot) =>
    set({ lightboxSnapshot: snapshot, lightboxTileId: null }),
  setLightboxSnapshotFavorite: (isFavorite, favoritedAt) =>
    set((s) =>
      s.lightboxSnapshot
        ? { lightboxSnapshot: { ...s.lightboxSnapshot, isFavorite, favoritedAt } }
        : {},
    ),

  // ---- favorites panel ----
  favoritesOpen: false,
  setFavoritesOpen: (open) => set({ favoritesOpen: open }),

  // ---- archived sources panel ----
  archivedSourcesPanelOpen: false,
  setArchivedSourcesPanelOpen: (open) => set({ archivedSourcesPanelOpen: open }),
}));

/** When the source list changes, decide what currentSourceId should be. Keeps
 * an existing valid selection; otherwise picks the newest active source. */
function pickCurrent(
  prev: string | null,
  sources: ReadonlyArray<Source>,
): string | null {
  if (prev && sources.some((s) => s.sourceId === prev)) return prev;
  const active = sources.filter((s) => s.archivedAt === null);
  return active[0]?.sourceId ?? null;
}
