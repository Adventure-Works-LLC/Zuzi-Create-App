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
   *  waiting for a refetch. Throws on failure (caller surfaces). */
  uploadFile: (file: File) => Promise<StylePainting>;
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
    setLoading(true);
    setError(null);
    try {
      const resp = await authFetch(
        "/api/style-paintings?archived=false&limit=200",
        { signal: ac.signal },
      );
      if (!resp.ok) {
        throw new Error(`style-paintings fetch failed (${resp.status})`);
      }
      const data = (await resp.json()) as {
        stylePaintings: StylePaintingResponseRow[];
      };
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

  const uploadFile = useCallback(
    async (file: File): Promise<StylePainting> => {
      setUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const resp = await authFetch("/api/style-paintings", {
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
        const data = (await resp.json()) as StylePaintingResponseRow;
        const row = rowToStylePainting(data);
        addStylePainting(row);
        return row;
      } finally {
        setUploading(false);
      }
    },
    [addStylePainting, setUploading, setError],
  );

  const deleteForever = useCallback(
    async (id: string) => {
      // Optimistic store removal. Rollback on failure via refresh.
      removeStylePainting(id);
      try {
        const resp = await authFetch(
          `/api/style-paintings/${encodeURIComponent(id)}?permanent=true`,
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
        await refresh();
        throw e;
      }
    },
    [removeStylePainting, refresh],
  );

  return {
    loading,
    error,
    uploading,
    uploadFile,
    deleteForever,
    refresh,
  };
}
