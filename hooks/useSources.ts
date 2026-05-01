"use client";

/**
 * useSources — hydrate the canvas store's sources[] from /api/sources, and
 * expose addSource (upload via multipart) + archiveSource.
 *
 * Cold-start contract per the plan: on PWA mount, fetch
 * `/api/sources?archived=false&limit=10` and populate the strip; the store
 * picks the most-recent active source as currentSourceId. If the user has no
 * sources yet, currentSourceId stays null and the empty state renders.
 *
 * State location: `loading`, `error`, `uploading` live in the canvas store
 * (not local useState) so multiple call sites — page, InputBar, SourceStrip,
 * Lightbox — share a single source of truth. In particular, an upload kicked
 * off from SourceStrip must disable the InputBar's Generate button. See
 * AGENTS.md §1 (single-instance contract is a server concern; on the client
 * the store is just a Zustand singleton).
 *
 * Uses plain fetch + AbortController (no React Query — see plan §State).
 */

import { useCallback, useEffect, useRef } from "react";

import { useCanvas, type Source } from "@/stores/canvas";

interface SourceResponseRow {
  id: string;
  inputKey: string;
  originalFilename: string | null;
  w: number;
  h: number;
  aspectRatio: string;
  createdAt: number;
  archivedAt: number | null;
  iterationCount?: number;
  favoriteCount?: number;
}

function rowToSource(r: SourceResponseRow): Source {
  return {
    sourceId: r.id,
    inputKey: r.inputKey,
    w: r.w,
    h: r.h,
    aspectRatio: r.aspectRatio,
    uploadedAt: r.createdAt,
    archivedAt: r.archivedAt,
  };
}

export interface UseSourcesResult {
  loading: boolean;
  error: string | null;
  uploading: boolean;
  uploadFile: (file: File) => Promise<Source>;
  /** Server-side promote-from-tile path used by the Lightbox's "Use as
   *  Source" button. Sends `{promoteFromTileId}` JSON to /api/sources;
   *  server reads the tile's output bytes from R2, runs the same sharp
   *  normalize as a multipart upload, inserts a sources row, returns the
   *  same shape. Avoids the client fetch+upload roundtrip and the 1h
   *  presigned-URL expiry footgun (lightbox open >1h would otherwise hit
   *  an expired URL on the client fetch step). */
  promoteFromTile: (tileId: string) => Promise<Source>;
  /** Soft-archive (PATCH `{archived: true}`). Reversible via `unarchive`. */
  archive: (sourceId: string) => Promise<void>;
  /** Reverse of archive (PATCH `{archived: false}`). Triggers a refresh of
   *  the active strip so the unarchived source reappears at its
   *  created_at slot. The ArchivedSourcesPanel reads from a separate
   *  fetch — it refetches on its own each open, so the row will be
   *  visibly absent from the panel after this resolves. */
  unarchive: (sourceId: string) => Promise<void>;
  /** Hard-delete the source row + every R2 object that belongs to it.
   *  Irreversible. Server-side does the R2 cleanup; the client-side
   *  store removal happens optimistically before the network roundtrip
   *  to keep the UI snappy. On failure: refresh the active strip to
   *  recover canonical state (the deleted source will reappear), then
   *  rethrow so the caller can surface the error. */
  deleteForever: (sourceId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSources(): UseSourcesResult {
  const setSources = useCanvas((s) => s.setSources);
  const addSourceToStore = useCanvas((s) => s.addSource);
  const archiveSourceInStore = useCanvas((s) => s.archiveSource);
  const removeSourceInStore = useCanvas((s) => s.removeSource);
  const setSourcesLoading = useCanvas((s) => s.setSourcesLoading);
  const setSourcesError = useCanvas((s) => s.setSourcesError);
  const setUploading = useCanvas((s) => s.setUploading);

  const loading = useCanvas((s) => s.sourcesLoading);
  const error = useCanvas((s) => s.sourcesError);
  const uploading = useCanvas((s) => s.uploading);

  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const resp = await fetch("/api/sources?archived=false&limit=10", {
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`sources fetch failed (${resp.status})`);
      }
      const data = (await resp.json()) as { sources: SourceResponseRow[] };
      setSources(data.sources.map(rowToSource));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setSourcesError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourcesLoading(false);
    }
  }, [setSources, setSourcesLoading, setSourcesError]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  const uploadFile = useCallback(
    async (file: File): Promise<Source> => {
      setUploading(true);
      setSourcesError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const resp = await fetch("/api/sources", {
          method: "POST",
          body: form,
        });
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(
            data.detail ?? data.error ?? `upload failed (${resp.status})`,
          );
        }
        const data = (await resp.json()) as {
          sourceId: string;
          inputKey: string;
          w: number;
          h: number;
          aspectRatio: string;
        };
        const source: Source = {
          sourceId: data.sourceId,
          inputKey: data.inputKey,
          w: data.w,
          h: data.h,
          aspectRatio: data.aspectRatio,
          uploadedAt: Date.now(),
          archivedAt: null,
        };
        addSourceToStore(source);
        return source;
      } finally {
        setUploading(false);
      }
    },
    [addSourceToStore, setUploading, setSourcesError],
  );

  const promoteFromTile = useCallback(
    async (tileId: string): Promise<Source> => {
      setUploading(true);
      setSourcesError(null);
      try {
        const resp = await fetch("/api/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ promoteFromTileId: tileId }),
        });
        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          // Bubble the server's detail up so the Lightbox can surface a
          // useful error instead of a console-warned blob (the original
          // failure mode that hid this whole bug).
          throw new Error(
            data.detail ?? data.error ?? `promote failed (${resp.status})`,
          );
        }
        const data = (await resp.json()) as {
          sourceId: string;
          inputKey: string;
          w: number;
          h: number;
          aspectRatio: string;
        };
        const source: Source = {
          sourceId: data.sourceId,
          inputKey: data.inputKey,
          w: data.w,
          h: data.h,
          aspectRatio: data.aspectRatio,
          uploadedAt: Date.now(),
          archivedAt: null,
        };
        addSourceToStore(source);
        return source;
      } finally {
        setUploading(false);
      }
    },
    [addSourceToStore, setUploading, setSourcesError],
  );

  const archive = useCallback(
    async (sourceId: string) => {
      // Optimistic update — pull from store immediately. Roll back on failure.
      archiveSourceInStore(sourceId);
      try {
        const resp = await fetch(`/api/sources/${sourceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        });
        if (!resp.ok) {
          throw new Error(`archive failed (${resp.status})`);
        }
      } catch (e) {
        // Rollback — refetch the canonical list.
        await refresh();
        throw e;
      }
    },
    [archiveSourceInStore, refresh],
  );

  const unarchive = useCallback(
    async (sourceId: string) => {
      // PATCH server first, then refresh the active strip so the row
      // reappears in the SourceStrip. We don't optimistically add the
      // row back to the store because we don't have the full Source
      // shape on hand (the panel only carries summary fields like
      // archivedAt; the active-strip query joins iterations + tiles
      // for aggregate counts, which we'd be missing). Refresh is the
      // canonical-state path.
      const resp = await fetch(`/api/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(
          data.detail ?? data.error ?? `unarchive failed (${resp.status})`,
        );
      }
      await refresh();
    },
    [refresh],
  );

  const deleteForever = useCallback(
    async (sourceId: string) => {
      // Optimistic store removal (same shape as archive). The active
      // strip drops the thumb immediately. The DELETE call is followed
      // by a refresh so the canonical state is restored — particularly
      // important if the deleted source was archived (and so wasn't in
      // the active store at all), since this method is also called
      // from the ArchivedSourcesPanel.
      removeSourceInStore(sourceId);
      try {
        const resp = await fetch(
          `/api/sources/${encodeURIComponent(sourceId)}?permanent=true`,
          { method: "DELETE" },
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
        // Rollback to canonical server state on failure. Throws after
        // refresh so caller can surface to the user.
        await refresh();
        throw e;
      }
    },
    [removeSourceInStore, refresh],
  );

  return {
    loading,
    error,
    uploading,
    uploadFile,
    promoteFromTile,
    archive,
    unarchive,
    deleteForever,
    refresh,
  };
}
