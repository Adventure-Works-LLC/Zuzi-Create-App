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

/**
 * Style painting — one entry in Zuzi's reference library (Sargent, Sorolla,
 * Wyeth, etc.), used as the SECOND image input in Style Explore mode.
 * Shape mirrors `Source` plus optional metadata (title surfaced in v2.1;
 * artist/note/tag schema-resident for v0.2+ edit UI). `inputKey` lives at
 * `styles/<id>.jpg` per the migration 0006 header.
 */
export interface StylePainting {
  id: string;
  inputKey: string;
  originalFilename: string | null;
  w: number;
  h: number;
  aspectRatio: string;
  title: string | null;
  artist: string | null;
  note: string | null;
  tag: string | null;
  createdAt: number;
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
  /**
   * Per-tile style attribution. Populated for tiles generated under a
   * style_explore-mode iteration (one entry per tile, index-aligned with
   * the iteration's `stylePaintingIds` request). NULL for prompt-mode
   * tiles. Powers the StyleAttributionThumb under each result tile + the
   * Lightbox toolbar's "Iterate on this direction" swap. The library is
   * already hydrated in `stylePaintings[]`, so the client can look up
   * title/inputKey for this id without an extra fetch.
   */
  stylePaintingId: string | null;
}

/** Iteration mode discriminator. 'prompt' (default) runs the existing
 *  preset-driven flow; 'style_explore' runs the locked multi-image
 *  directive (sketch + style painting per tile); 'style_blend' fuses N
 *  tile outputs; 'sketch_vary' (v5) runs the source through the ZUZQ
 *  FLUX LoRA — settle/perfect in her own hand. See AGENTS.md §13/§14/§16. */
export type IterationMode =
  | "prompt"
  | "style_explore"
  | "style_blend"
  | "sketch_vary";

/** The InputBar pill's pickable tiers: Gemini Flash/Pro + the v5.4 fal
 *  engines (FLUX 2 Max, Seedream 5-Lite). See AGENTS.md §17. */
export type ModelTier = "flash" | "pro" | "flux2max" | "seedream";
/** What an ITERATION ran on — everything pickable plus 'flux' (v5
 *  sketch_vary rows: the ZUZQ LoRA, forced by mode, never picked).
 *  Keep the types separate so pricing lookups can't be fed 'flux' by
 *  the compiler. */
export type EngineTier = ModelTier | "flux";
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
  modelTier: EngineTier;
  resolution: Resolution;
  /** v2.4: per-tile style attribution. Populated for snapshots of
   *  style_explore tiles (and prompt-mode tiles spawned via "Iterate on
   *  this direction") so the Lightbox can swap "Use as source" →
   *  "Iterate on this direction" + swap Compare's target to the style
   *  painting (not the source). NULL for prompt-mode-without-handoff
   *  tiles. The favorites query joins this column from `tiles`. */
  stylePaintingId: string | null;
  /** v3.1: iteration mode this tile belongs to. Required by the
   *  Lightbox to detect blend tiles (mode='style_blend') and hide
   *  Compare — blend doesn't use the source as input, so a
   *  before/after pair would be misleading. Optional in the type
   *  to tolerate older clients opening favorites generated before
   *  the field existed (Lightbox defaults missing to 'prompt').
   *  sketch_vary tiles keep Compare — source vs varied IS the honest
   *  before/after. */
  iterationMode?: IterationMode;
  /** v5.6: the tile's iteration's "Her colors" switch state. Optional
   *  for back-compat with pre-v5.6 snapshots; missing → false. */
  keepSourceColors?: boolean;
}

export interface Iteration {
  id: string;
  sourceId: string;
  modelTier: EngineTier;
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
  /** Iteration mode. 'prompt' = preset-driven flow. 'style_explore' =
   *  sketch + ONE style per tile via locked directive. 'style_blend'
   *  (v3.0) = N styles fused, NO sketch input — Pro invents a new
   *  painting from the references. Each mode has its own IterationRow
   *  + Lightbox rendering. */
  mode: IterationMode;
  /** v2 provenance link. Set on prompt-mode iterations spawned from a
   *  style_explore tile via the lightbox's "Iterate on this direction"
   *  handoff — the parent tile id (across any source). NULL for
   *  organically-generated iterations. Surfaced in the
   *  IterationRow header as a small breadcrumb (future). */
  parentTileId: string | null;
  /** v3.0 style_blend: the N style ids that drove this iteration.
   *  Empty array for every other mode. Used by IterationRow + the
   *  Lightbox to render a row of attribution chips for blend tiles
   *  (no per-tile style_painting_id is set in blend mode — every tile
   *  shares the same N styles, so the attribution lives on the
   *  iteration). */
  blendTileIds: string[];
  /** v5 sketch_vary: the LoRA strength this iteration ran at (0.45 |
   *  0.6 | 0.75). NULL for every other mode. IterationRow renders it
   *  as the "vary · subtle/medium/wild" caption. */
  varyStrength: number | null;
  /** v5.6: Style Explore "Her colors" switch state at generation time.
   *  True = palette from the sketch, texture only from the reference.
   *  Always false for non-explore modes + pre-v5.6 rows. */
  keepSourceColors: boolean;
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
  /** v5.6.2: the "Her colors" switch — global, session-sticky, shown in
   *  the InputBar next to the Aspect pill. Every style_explore fire
   *  path (StylesPanel card-taps, ExploreSheet batches, Lightbox "More
   *  like this") reads it at fire time. ON = keep-source-colors
   *  directive variant (sketch keeps its palette; reference contributes
   *  texture only). */
  keepHerColors: boolean;
  setKeepHerColors: (v: boolean) => void;

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

  // ---- style paintings library (v2 Style Explore) ----
  // The reference library lives here as a flat list, hydrated by
  // `useStylePaintings()` on Studio mount. v2.1 only surfaces the active
  // (non-archived) set in the StylesPanel + future ExploreSheet; the
  // archive UI is deferred to v0.2 per the plan. State + mutators
  // intentionally mirror the sources slice — same upload-then-prepend +
  // remove-by-id contract — so the StylesPanel implementation feels
  // identical to ArchivedSourcesPanel + SourceStrip.
  stylePaintings: StylePainting[];
  stylesLoading: boolean;
  stylesError: string | null;
  stylesUploading: boolean;
  /** v2.1 UI flag toggled by the SourceStrip's 🎨 Styles button.
   *  StylesPanel mounts unconditionally and renders nothing when false,
   *  matching the FavoritesPanel + ArchivedSourcesPanel lifecycle. */
  stylesPanelOpen: boolean;
  setStylePaintings: (rows: StylePainting[]) => void;
  addStylePainting: (row: StylePainting) => void;
  removeStylePainting: (id: string) => void;
  /** v4.0: patch fields on one style painting row in place (artist
   *  tagging from the StylesPanel's Set-artist flow). No-op when the
   *  id isn't present. */
  updateStylePainting: (id: string, patch: Partial<StylePainting>) => void;
  setStylesLoading: (v: boolean) => void;
  setStylesError: (v: string | null) => void;
  setStylesUploading: (v: boolean) => void;
  setStylesPanelOpen: (open: boolean) => void;

  // ---- explore sheet (v2.2 Style Explore mode entry) ----
  // Toggled by the InputBar's "Explore styles →" button. ExploreSheet
  // is a z-50 modal overlay (above the z-40 panels, above Studio's
  // z-30 SourceStrip). Mounts unconditionally and renders nothing when
  // false, same lifecycle as the other panels but at a higher z-layer
  // because the sheet OWNS the screen while open — interaction with
  // SourceStrip / Generate is intentionally blocked.
  exploreSheetOpen: boolean;
  setExploreSheetOpen: (open: boolean) => void;

  // ---- v3.4 blend mode (multi-select on TileStream) ----
  // blendMode flag flips the main TileStream into a multi-select state:
  // tiles get a selection ring + numbered badge on tap, a floating
  // action bar appears at the bottom with "Blend N tiles". Selection
  // is scoped to the current source (the only tiles visible). All
  // local to the canvas store so SourceStrip / Tile / TileStream
  // share one truth.
  blendMode: boolean;
  /** Ordered list of selected tile ids — order = the index in the
   *  parts array sent to Gemini. Capped client-side at MAX_BLEND_TILES;
   *  server also enforces. */
  blendSelectedTileIds: string[];
  setBlendMode: (on: boolean) => void;
  /** Tap-toggle a tile id in/out of the selection. No-op if adding
   *  would exceed MAX_BLEND_TILES; remove always succeeds. Pass the
   *  max as a runtime arg so the store doesn't import lib/gemini
   *  (which would pull in Gemini SDK as a dep of the store). */
  toggleBlendSelection: (tileId: string, maxSelections: number) => void;
  /** Wipe selection (used on blend-mode exit + on source switch). */
  clearBlendSelection: () => void;
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
      // painting starts from the always-on baseline (Avery preset,
      // Match aspect). Sticky settings like modelTier / resolution / count
      // intentionally carry over since they reflect the user's working
      // tier preference, not painting-specific state.
      presets: ["avery"],
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
        presets: isSwitch ? ["avery"] : s.presets,
        aspectRatioMode: isSwitch ? "match" : s.aspectRatioMode,
        // v4.4: blend selection SURVIVES source switches — that's the
        // cross-source blend feature (select a tile from sketch A,
        // switch to sketch B, add one of its tiles, fire). The blend
        // lands on whichever source is current at fire time (that
        // source anchors the iteration + drives the output aspect per
        // AGENTS.md §3/§14). Selected tiles in non-visible streams keep
        // their ids in this array; their rings reappear when she
        // switches back. (v3.4 cleared both slots here under the old
        // same-source rule.)
        blendMode: s.blendMode,
        blendSelectedTileIds: s.blendSelectedTileIds,
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
        // v4.4: archive is a SOFT delete — the archived source's tiles
        // stay valid blend inputs (route only rejects hard-deleted
        // tiles), so an in-flight cross-source selection survives
        // archiving. (v3.5 cleared both slots when wasCurrent under
        // the old same-source rule.)
        blendMode: s.blendMode,
        blendSelectedTileIds: s.blendSelectedTileIds,
      };
    }),
  removeSource: (sourceId) =>
    set((s) => {
      // Same shape as archiveSource — see the comment on the type
      // declaration above for why this is a separate method despite
      // the same mutation logic.
      const remaining = s.sources.filter((x) => x.sourceId !== sourceId);
      const wasCurrent = s.currentSourceId === sourceId;
      // v4.4: hard delete kills the source's tiles, so scrub any of
      // them from the blend selection. When the removed source was
      // current, its iterations are in the store — collect their tile
      // ids and filter. A NON-current source's tiles aren't in the
      // store, so a stale id can survive here; the route's existence
      // check rejects it at fire time with a clean 404
      // (blend_tile_not_found) — documented defense-in-depth.
      const removedTileIds = wasCurrent
        ? new Set(
            s.iterations.flatMap((it) => it.tiles.map((t) => t.id)),
          )
        : null;
      return {
        sources: remaining,
        currentSourceId: wasCurrent ? pickCurrent(null, remaining) : s.currentSourceId,
        iterations: wasCurrent ? [] : s.iterations,
        blendMode: s.blendMode,
        blendSelectedTileIds: removedTileIds
          ? s.blendSelectedTileIds.filter((id) => !removedTileIds.has(id))
          : s.blendSelectedTileIds,
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
        // v3.5: scrub the deleted tile from any in-flight blend
        // selection. Without this, firing a blend with the orphan id
        // produces a 404 blend_tile_not_found from the route.
        blendSelectedTileIds: s.blendSelectedTileIds.filter(
          (x) => x !== tileId,
        ),
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
        // v3.5: scrub every tile of the deleted iteration from any
        // in-flight blend selection. Same rationale as removeTile.
        blendSelectedTileIds: s.blendSelectedTileIds.filter(
          (x) => !targetTileIds.has(x),
        ),
      };
    }),

  // ---- input-bar settings ----
  modelTier: "pro",
  resolution: "1k",
  aspectRatioMode: "match",
  // Avery is the always-on preset default (was 'background' in the
  // original 4-preset world; switched when Avery v1 shipped and Zuzi
  // started using it as her primary direction). The UI never sends an
  // empty preset array to /api/iterate — buildPrompt's empty-presets
  // branch stays as a defensive fallback for legacy data + smoke
  // testing, but the canonical UI state is always exactly one preset.
  // See InputBar.tsx for the picker-open transitional behavior that
  // visually shows all visible cells while preserving this invariant.
  presets: ["avery"],
  count: TILE_COUNT_DEFAULT,
  setModelTier: (modelTier) => set({ modelTier }),
  setResolution: (resolution) => set({ resolution }),
  setAspectRatioMode: (aspectRatioMode) => set({ aspectRatioMode }),
  setPreset: (preset) =>
    set({ presets: preset === null ? [] : [preset] }),
  keepHerColors: false,
  setKeepHerColors: (keepHerColors) => set({ keepHerColors }),
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

  // ---- style paintings library ----
  stylePaintings: [],
  // Default to NOT-loading so first render of the StylesPanel doesn't
  // flash a "Loading…" state before useStylePaintings's effect kicks in
  // (parallel to `sourcesLoading: true` which IS the cold-start signal
  // for the SourceStrip — the strip mounts immediately, the panel only
  // mounts on user demand).
  stylesLoading: false,
  stylesError: null,
  stylesUploading: false,
  stylesPanelOpen: false,
  setStylePaintings: (stylePaintings) => set({ stylePaintings }),
  addStylePainting: (row) =>
    set((s) => ({
      // Newest-first, dedupe by id (a re-upload of the same id is a
      // server-side ulid collision = impossible; this filter is defensive).
      stylePaintings: [row, ...s.stylePaintings.filter((x) => x.id !== row.id)],
    })),
  removeStylePainting: (id) =>
    set((s) => ({
      stylePaintings: s.stylePaintings.filter((x) => x.id !== id),
      // v4.6: mirror the server (nullifyTilesForStylePainting) — loaded
      // tiles keep a dead stylePaintingId otherwise, so the Lightbox
      // still offered "Iterate on this direction"/"More like this" for
      // a deleted style (both 404 at fire) until the next refetch,
      // while the attribution chip on the same tile already said
      // "Style unavailable". One store pass keeps every surface
      // agreeing.
      iterations: s.iterations.map((it) => {
        if (!it.tiles.some((t) => t.stylePaintingId === id)) return it;
        return {
          ...it,
          tiles: it.tiles.map((t) =>
            t.stylePaintingId === id ? { ...t, stylePaintingId: null } : t,
          ),
        };
      }),
    })),
  updateStylePainting: (id, patch) =>
    set((s) => ({
      stylePaintings: s.stylePaintings.map((x) =>
        x.id === id ? { ...x, ...patch } : x,
      ),
    })),
  setStylesLoading: (stylesLoading) => set({ stylesLoading }),
  setStylesError: (stylesError) => set({ stylesError }),
  setStylesUploading: (stylesUploading) => set({ stylesUploading }),
  setStylesPanelOpen: (open) => set({ stylesPanelOpen: open }),

  // ---- explore sheet ----
  exploreSheetOpen: false,
  setExploreSheetOpen: (open) => set({ exploreSheetOpen: open }),

  // ---- v3.4 blend mode ----
  blendMode: false,
  blendSelectedTileIds: [],
  setBlendMode: (on) =>
    set((s) =>
      on
        ? { blendMode: true }
        : { blendMode: false, blendSelectedTileIds: [] },
    ),
  toggleBlendSelection: (tileId, maxSelections) =>
    set((s) => {
      const at = s.blendSelectedTileIds.indexOf(tileId);
      if (at >= 0) {
        return {
          blendSelectedTileIds: s.blendSelectedTileIds.filter(
            (x) => x !== tileId,
          ),
        };
      }
      if (s.blendSelectedTileIds.length >= maxSelections) return {}; // capped
      return {
        blendSelectedTileIds: [...s.blendSelectedTileIds, tileId],
      };
    }),
  clearBlendSelection: () => set({ blendSelectedTileIds: [] }),
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
