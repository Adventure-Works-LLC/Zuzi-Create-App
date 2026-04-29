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

  // ---- input-bar settings ----
  modelTier: ModelTier;
  resolution: Resolution;
  presets: Preset[];
  count: number;
  setModelTier: (tier: ModelTier) => void;
  setResolution: (resolution: Resolution) => void;
  togglePreset: (preset: Preset) => void;
  setCount: (count: number) => void;

  // ---- lightbox ----
  lightboxTileId: string | null;
  setLightboxTile: (tileId: string | null) => void;

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
    })),

  // ---- input-bar settings ----
  modelTier: "pro",
  resolution: "1k",
  presets: [],
  count: TILE_COUNT_DEFAULT,
  setModelTier: (modelTier) => set({ modelTier }),
  setResolution: (resolution) => set({ resolution }),
  togglePreset: (preset) =>
    set((s) => ({
      presets: s.presets.includes(preset)
        ? s.presets.filter((p) => p !== preset)
        : [...s.presets, preset],
    })),
  setCount: (count) => set({ count }),

  // ---- lightbox ----
  lightboxTileId: null,
  setLightboxTile: (tileId) => set({ lightboxTileId: tileId }),

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
