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
  /** From `sources.aspect_ratio` of whichever source produced the tile —
   *  used by the Lightbox to render at correct aspect, and by Use-as-source
   *  if the user wants to fork from this favorite. */
  sourceAspectRatio: string;
  modelTier: ModelTier;
  resolution: Resolution;
}

export interface Iteration {
  id: string;
  sourceId: string;
  modelTier: ModelTier;
  resolution: Resolution;
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

  // ---- input-bar settings ----
  modelTier: ModelTier;
  resolution: Resolution;
  presets: Preset[];
  count: number;
  setModelTier: (tier: ModelTier) => void;
  setResolution: (resolution: Resolution) => void;
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
    })),
  setCurrentSource: (sourceId) =>
    set((s) => ({
      currentSourceId: sourceId,
      // Switching sources blanks the stream — the iteration hook refetches.
      iterations: sourceId === s.currentSourceId ? s.iterations : [],
    })),
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
      iterations: s.iterations.map((it) => ({
        ...it,
        tiles: it.tiles.map((t) =>
          t.id === tileId ? { ...t, isFavorite, favoritedAt } : t,
        ),
      })),
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

  // ---- input-bar settings ----
  modelTier: "pro",
  resolution: "1k",
  presets: [],
  count: TILE_COUNT_DEFAULT,
  setModelTier: (modelTier) => set({ modelTier }),
  setResolution: (resolution) => set({ resolution }),
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
