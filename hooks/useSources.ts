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
 * Uses plain fetch + AbortController (no React Query — see plan §State).
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
  archive: (sourceId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSources(): UseSourcesResult {
  const setSources = useCanvas((s) => s.setSources);
  const addSourceToStore = useCanvas((s) => s.addSource);
  const archiveSourceInStore = useCanvas((s) => s.archiveSource);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setSources]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  const uploadFile = useCallback(
    async (file: File): Promise<Source> => {
      setUploading(true);
      setError(null);
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
    [addSourceToStore],
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

  return { loading, error, uploading, uploadFile, archive, refresh };
}
