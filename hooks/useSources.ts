"use client";

/**
 * useSources — hydrate the canvas store's sources[] from /api/sources, and
 * expose addSource (upload via multipart) + archiveSource.
 *
 * Cold-start contract per the plan: on PWA mount, fetch
 * `/api/sources?archived=false&limit=100` and populate the strip; the store
 * picks the most-recent active source as currentSourceId. If the user has no
 * sources yet, currentSourceId stays null and the empty state renders.
 *
 * limit history: v1 fetched 10 (matched the plan's "3–10 sources in
 * flight"). Real usage accumulates actives well past 10 — sources beyond
 * the fetch limit are alive in the DB but unreachable in the UI, which
 * reads as data loss ("where did my sketch go"). 100 is the server-side
 * clamp in app/api/sources/route.ts; the strip scrolls horizontally and
 * thumbs are loading="lazy" so a long strip stays cheap. If the active
 * count ever nears 100, that's the cue to build a browse-all-sources
 * panel (and/or lean on archiving), not to bump the number again.
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
import { authFetch } from "@/lib/auth/authFetch";
import {
  TIMEOUT_JSON_MS,
  TIMEOUT_UPLOAD_MS,
  withTimeout,
} from "@/lib/fetchTimeout";

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

// Module-scoped attempt-time stamp shared by every useSources instance —
// see the visibilitychange effect for why this can't be a per-instance ref.
let lastSourcesRefreshAt = 0;

// v4.6: module-scoped invalidation epoch for the sources list — same
// pattern as useIterations's iterationsListEpoch. Every mutation
// (upload, promote, archive, unarchive, hard delete) bumps it before
// touching the store; any refresh whose fetch STARTED under an older
// epoch discards its response instead of setSources-replacing newer
// state. Without this, an in-flight refresh (visibilitychange fires one
// when the iPad file picker dismisses!) whose server snapshot predates
// an upload's insert would land after the optimistic addSource and wipe
// the new source from the strip — pickCurrent then yanks the selection
// to a different painting. Module-scoped because this hook has ~5 call
// sites, each with its own in-flight fetch an instance-local abort
// can't reach.
let sourcesListEpoch = 0;

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
    lastSourcesRefreshAt = Date.now();
    const epochAtStart = sourcesListEpoch;
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const resp = await authFetch(
        "/api/sources?archived=false&limit=100",
        withTimeout({ signal: ac.signal }, TIMEOUT_JSON_MS),
      );
      if (!resp.ok) {
        throw new Error(`sources fetch failed (${resp.status})`);
      }
      const data = (await resp.json()) as { sources: SourceResponseRow[] };
      if (epochAtStart !== sourcesListEpoch) return; // stale snapshot
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

  // Refetch when the app returns to the foreground. iPad PWAs restore
  // from the app switcher with whatever page state they were suspended
  // with — a source uploaded from another device (desktop ↔ iPad) never
  // appeared until a full app relaunch. Same visibilitychange pattern as
  // useStreamingResults's SSE reconnect. The 15s guard keeps rapid
  // app-switching from churning refetches; setSources preserves the
  // current selection via pickCurrent, so a background refresh never
  // yanks the source she's working on.
  //
  // The guard stamp is MODULE-scoped (not a ref) because useSources has
  // ~5 call sites, each registering its own listener here. refresh()
  // stamps synchronously before its first await, so the first listener
  // to run blocks the other four in the same dispatch — one visibility
  // flip = one refetch, not five.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastSourcesRefreshAt < 15_000) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  const uploadFile = useCallback(
    async (file: File): Promise<Source> => {
      // v4.6: kill any in-flight refresh on this instance early; the
      // epoch bump below (before addSourceToStore) is what protects
      // against the other instances' fetches.
      abortRef.current?.abort();
      setUploading(true);
      setSourcesError(null);
      try {
        // v5.4.2: raw-bytes upload — the file IS the body, filename in a
        // header. Multipart's parser (undici server-side) was rejecting
        // truncated iPad bodies with "Failed to parse body as FormData";
        // a single binary body has nothing to mis-parse. The server keeps
        // the multipart branch for old cached tabs.
        const resp = await authFetch(
          "/api/sources",
          withTimeout(
            {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                "x-filename": encodeURIComponent(file.name ?? ""),
              },
              body: file,
            },
            TIMEOUT_UPLOAD_MS,
          ),
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
        sourcesListEpoch++; // invalidate pre-insert snapshots
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
      abortRef.current?.abort();
      setUploading(true);
      setSourcesError(null);
      try {
        const resp = await authFetch(
          "/api/sources",
          withTimeout(
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ promoteFromTileId: tileId }),
            },
            // JSON body but the server does R2 fetch + sharp work —
            // upload-class budget.
            TIMEOUT_UPLOAD_MS,
          ),
        );
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
        sourcesListEpoch++; // invalidate pre-insert snapshots
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
      // v4.6: abort + epoch-bump BEFORE the optimistic mutation so a stale
      // in-flight refresh can't resurrect the archived row in the strip.
      abortRef.current?.abort();
      sourcesListEpoch++;
      archiveSourceInStore(sourceId);
      try {
        const resp = await authFetch(
          `/api/sources/${sourceId}`,
          withTimeout(
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ archived: true }),
            },
            TIMEOUT_JSON_MS,
          ),
        );
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
      const resp = await authFetch(
        `/api/sources/${sourceId}`,
        withTimeout(
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ archived: false }),
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
          data.detail ?? data.error ?? `unarchive failed (${resp.status})`,
        );
      }
      // v4.6: bump so any OLDER in-flight refresh (snapshot without the
      // unarchived row) can't land after this refresh and vanish it again.
      sourcesListEpoch++;
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
      // v4.6: abort + epoch-bump before the optimistic removal — a stale
      // refresh landing later would otherwise resurrect a server-dead
      // ghost row in the strip (tapping it selects a nonexistent source).
      abortRef.current?.abort();
      sourcesListEpoch++;
      removeSourceInStore(sourceId);
      try {
        const resp = await authFetch(
          `/api/sources/${encodeURIComponent(sourceId)}?permanent=true`,
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
