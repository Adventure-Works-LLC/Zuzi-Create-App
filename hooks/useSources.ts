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
  archive: (sourceId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSources(): UseSourcesResult {
  const setSources = useCanvas((s) => s.setSources);
  const addSourceToStore = useCanvas((s) => s.addSource);
  const archiveSourceInStore = useCanvas((s) => s.archiveSource);
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

  return { loading, error, uploading, uploadFile, promoteFromTile, archive, refresh };
}
