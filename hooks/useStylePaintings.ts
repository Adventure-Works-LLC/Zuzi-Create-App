"use client";

/**
 * useStylePaintings — hydrate the canvas store's stylePaintings[] from
 * /api/style-paintings, and expose uploadFile (multipart, single-file)
 * + deleteForever (hard delete + R2 cleanup).
 *
 * Mirrors useSources's lifecycle: fetch on mount, store-side state (loading
 * / error / uploading flags so the StylesPanel + future ExploreSheet can
 * share a single source of truth), optimistic mutation on delete with
 * rollback-via-refresh on failure.
 *
 * For multi-file uploads the caller fires N parallel `uploadFile(file)`
 * calls — each one creates its own server row + R2 object so the operation
 * is naturally idempotent at the file level. The store's `addStylePainting`
 * dedupes by id (defensive against impossible ulid collisions).
 *
 * v2.1 surfaces only the active set (`archived=false`); the
 * archive/unarchive helpers are deferred until v0.2 when the archive UI
 * lands, matching the plan's deferred-features list.
 *
 * Uses plain fetch + AbortController + authFetch — same pattern as the
 * rest of the hooks tier.
 */

import { useCallback, useEffect, useRef } from "react";

import { authFetch } from "@/lib/auth/authFetch";
import {
  TIMEOUT_JSON_MS,
  TIMEOUT_UPLOAD_MS,
  withTimeout,
} from "@/lib/fetchTimeout";
import { useCanvas, type StylePainting } from "@/stores/canvas";

interface StylePaintingResponseRow {
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

// Module-scoped attempt-time stamp shared by every useStylePaintings
// instance — mirrors useSources's lastSourcesRefreshAt rationale.
let lastStylesRefreshAt = 0;

// v4.6: module-scoped invalidation epoch — mirrors useSources's
// sourcesListEpoch (see the comment there). Bumped by every mutation
// before it touches the store; refreshes that started under an older
// epoch discard their response. Closes the bulk-upload race (a
// visibilitychange refresh fired by the file-picker dismiss, landing
// mid-pool with a pre-insert snapshot, wiped rows that completed
// uploads had already added — "some of my uploads vanished") AND the
// cross-instance deleteForever gap (this hook has 2 instances; the
// instance-local abort can't reach the other one's in-flight fetch).
let stylesListEpoch = 0;

// v4.6: module-scoped active-upload counter. The store's `uploading`
// flag is a boolean; with the StylesPanel's 3-worker pool, the FIRST
// completed file's `finally` was flipping it false while siblings were
// still in flight — the header button re-enabled mid-batch and a second
// batch could stack another 3 workers on top. Count up/down and only
// clear the flag at zero.
let activeStyleUploads = 0;

function rowToStylePainting(r: StylePaintingResponseRow): StylePainting {
  return {
    id: r.id,
    inputKey: r.inputKey,
    originalFilename: r.originalFilename,
    w: r.w,
    h: r.h,
    aspectRatio: r.aspectRatio,
    title: r.title,
    artist: r.artist,
    note: r.note,
    tag: r.tag,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
  };
}

export interface UseStylePaintingsResult {
  loading: boolean;
  error: string | null;
  uploading: boolean;
  /** Upload one image. The server returns the persisted row; we add it
   *  to the store optimistically so the StylesPanel grid updates without
   *  waiting for a refetch. Throws on failure (caller surfaces).
   *  v4.0: optional `artist` batch-tags the upload (the StylesPanel
   *  prompts once per multi-file batch and stamps every file). */
  uploadFile: (file: File, artist?: string | null) => Promise<StylePainting>;
  /** v4.0: set (or clear, via null) the artist on one style painting.
   *  PATCH first, then store update — not optimistic, so a failed PATCH
   *  never leaves the filter chips lying about server state. Throws on
   *  failure (caller surfaces). */
  setArtist: (id: string, artist: string | null) => Promise<void>;
  /** Hard delete + R2 cleanup. Server-side nullifies any referenced
   *  `tiles.style_painting_id` first (see migration 0006 header). The
   *  store-side removal is optimistic; on failure we refetch to recover
   *  canonical state, then rethrow. Irreversible. */
  deleteForever: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useStylePaintings(): UseStylePaintingsResult {
  const setStylePaintings = useCanvas((s) => s.setStylePaintings);
  const addStylePainting = useCanvas((s) => s.addStylePainting);
  const removeStylePainting = useCanvas((s) => s.removeStylePainting);
  const updateStylePainting = useCanvas((s) => s.updateStylePainting);
  const setLoading = useCanvas((s) => s.setStylesLoading);
  const setError = useCanvas((s) => s.setStylesError);
  const setUploading = useCanvas((s) => s.setStylesUploading);

  const loading = useCanvas((s) => s.stylesLoading);
  const error = useCanvas((s) => s.stylesError);
  const uploading = useCanvas((s) => s.stylesUploading);

  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    lastStylesRefreshAt = Date.now();
    setLoading(true);
    setError(null);
    const epochAtStart = stylesListEpoch;
    try {
      const resp = await authFetch(
        "/api/style-paintings?archived=false&limit=200",
        withTimeout({ signal: ac.signal }, TIMEOUT_JSON_MS),
      );
      if (!resp.ok) {
        throw new Error(`style-paintings fetch failed (${resp.status})`);
      }
      const data = (await resp.json()) as {
        stylePaintings: StylePaintingResponseRow[];
      };
      if (epochAtStart !== stylesListEpoch) return; // stale snapshot
      setStylePaintings(data.stylePaintings.map(rowToStylePainting));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setStylePaintings, setLoading, setError]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  // Foreground refetch — same iPad-PWA staleness fix as useSources (see
  // the comment there, incl. why the guard stamp is module-scoped: this
  // hook has multiple call sites, one refetch per visibility flip).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastStylesRefreshAt < 15_000) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  const uploadFile = useCallback(
    async (file: File, artist?: string | null): Promise<StylePainting> => {
      // v4.6: kill this instance's in-flight refresh early; the epoch
      // bump before addStylePainting handles the other instances.
      abortRef.current?.abort();
      activeStyleUploads++;
      setUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        if (artist && artist.trim().length > 0) {
          form.append("artist", artist.trim());
        }
        const resp = await authFetch(
          "/api/style-paintings",
          withTimeout({ method: "POST", body: form }, TIMEOUT_UPLOAD_MS),
        );
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(
            data.detail ?? data.error ?? `upload failed (${resp.status})`,
          );
        }
        const data = (await resp.json()) as StylePaintingResponseRow;
        const row = rowToStylePainting(data);
        stylesListEpoch++; // invalidate pre-insert snapshots
        addStylePainting(row);
        return row;
      } finally {
        activeStyleUploads--;
        if (activeStyleUploads <= 0) {
          activeStyleUploads = 0;
          setUploading(false);
        }
      }
    },
    [addStylePainting, setUploading, setError],
  );

  const deleteForever = useCallback(
    async (id: string) => {
      // Abort any in-flight refresh BEFORE the optimistic removal +
      // network DELETE. Otherwise a refresh that fired moments earlier
      // (e.g., from a parallel uploadFile completion or the mount
      // effect still resolving) can land its response AFTER our
      // optimistic remove and re-insert the just-deleted style via
      // setStylePaintings(...). The abort makes the response a no-op.
      abortRef.current?.abort();
      // v4.6: the abort above only reaches THIS instance's in-flight
      // refresh; the epoch bump covers the other instance's (the
      // cross-instance re-insert race from the network audit).
      stylesListEpoch++;
      // Optimistic store removal. Rollback on failure via refresh.
      removeStylePainting(id);
      try {
        const resp = await authFetch(
          `/api/style-paintings/${encodeURIComponent(id)}?permanent=true`,
          withTimeout({ method: "DELETE" }, TIMEOUT_JSON_MS),
        );
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(
            data.detail ?? data.error ?? `delete failed (${resp.status})`,
          );
        }
      } catch (e) {
        await refresh();
        throw e;
      }
    },
    [removeStylePainting, refresh],
  );

  const setArtist = useCallback(
    async (id: string, artist: string | null) => {
      const resp = await authFetch(
        `/api/style-paintings/${encodeURIComponent(id)}`,
        withTimeout(
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artist }),
          },
          TIMEOUT_JSON_MS,
        ),
      );
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(
          data.detail ?? data.error ?? `artist update failed (${resp.status})`,
        );
      }
      // v4.6: bump so an in-flight refresh with a pre-PATCH snapshot
      // can't revert the artist edit (and its filter chips) on landing.
      stylesListEpoch++;
      updateStylePainting(id, { artist });
    },
    [updateStylePainting],
  );

  return {
    loading,
    error,
    uploading,
    uploadFile,
    setArtist,
    deleteForever,
    refresh,
  };
}
