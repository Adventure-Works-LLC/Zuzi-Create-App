"use client";

/**
 * useImageUrl — React hook that fetches a presigned URL for an R2 key, caches it
 * in memory until shortly before expiry, and triggers a refetch when needed.
 *
 * Cache is module-scoped (one Map per browser tab). No persistence — a page reload
 * costs a fresh /api/image-url call per displayed image, which is acceptable at
 * one-user scale and avoids any leaked-URL persistence in localStorage / IndexedDB.
 *
 * Refetch buffer: a URL with < 60s remaining is treated as expired and refetched.
 * The on-screen image keeps showing the old URL during the refetch (no flicker).
 *
 * See AGENTS.md §7 for the privacy / threat model behind signed URLs.
 */

import { useEffect, useState } from "react";

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const REFRESH_BUFFER_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

async function fetchSignedUrl(key: string): Promise<CacheEntry> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const resp = await fetch(
      `/api/image-url?key=${encodeURIComponent(key)}`,
      { cache: "no-store" },
    );
    if (!resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `image-url HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { url: string; expiresAt: number };
    const entry: CacheEntry = { url: data.url, expiresAt: data.expiresAt };
    cache.set(key, entry);
    return entry;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

export interface UseImageUrlResult {
  url: string | null;
  loading: boolean;
  error: string | null;
}

export function useImageUrl(key: string | null | undefined): UseImageUrlResult {
  const [state, setState] = useState<UseImageUrlResult>(() => {
    if (!key) return { url: null, loading: false, error: null };
    const cached = cache.get(key);
    const fresh =
      cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS;
    return {
      url: cached?.url ?? null,
      loading: !fresh,
      error: null,
    };
  });

  useEffect(() => {
    if (!key) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    let cancelled = false;

    const cached = cache.get(key);
    const fresh = cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS;
    if (fresh) {
      setState({ url: cached.url, loading: false, error: null });
      return;
    }

    setState((prev) => ({
      url: prev.url ?? cached?.url ?? null,
      loading: true,
      error: null,
    }));

    fetchSignedUrl(key)
      .then((entry) => {
        if (cancelled) return;
        setState({ url: entry.url, loading: false, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          url: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}
