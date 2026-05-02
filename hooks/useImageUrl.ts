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
 * Background auto-refresh: when a URL is resolved, the hook also schedules a
 * setTimeout to refetch (REFRESH_BUFFER_MS) before the URL would expire. This
 * means a thumb mounted at minute 5 with a URL valid through minute 65 silently
 * refreshes around minute 64 — the user never sees a 403, even on a long
 * curation session or after the iPad wakes from sleep. Consumers don't need
 * any onError plumbing; the URL just stays valid. Cache updates from any
 * source (manual mount-time fetch OR scheduled refresh) are broadcast to all
 * subscribed consumers via a tiny per-key subscriber set so that a refresh
 * triggered by one mounted hook updates every other hook on the same key in
 * the same render cycle.
 *
 * See AGENTS.md §7 for the privacy / threat model behind signed URLs.
 */

import { useEffect, useRef, useState } from "react";

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const REFRESH_BUFFER_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

/** Per-key subscriber registry. Each mounted useImageUrl call registers a
 *  setState fn keyed by R2 key; cache writes notify every subscriber for the
 *  key so a background refresh by one consumer updates every other consumer
 *  on the same image without each one needing its own setTimeout. */
type Subscriber = (entry: CacheEntry) => void;
const subscribers = new Map<string, Set<Subscriber>>();

/** Module-scoped scheduled refresh timers, one per key. Multiple consumers
 *  subscribed to the same key share a single timer (the timer is created when
 *  the cache gets a fresh entry, and cleared on cache invalidation). This
 *  matches the in-flight dedupe pattern: one timer per key, regardless of how
 *  many components are watching that key. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function notifySubscribers(key: string, entry: CacheEntry): void {
  const set = subscribers.get(key);
  if (!set) return;
  for (const sub of set) sub(entry);
}

function clearRefreshTimer(key: string): void {
  const existing = refreshTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    refreshTimers.delete(key);
  }
}

/** Schedule a background refetch shortly before the URL expires. Replaces
 *  any existing timer for the same key (idempotent — calling this twice in
 *  a row only ever has one outstanding timer). The refetch reuses the
 *  in-flight dedupe in fetchSignedUrl so two timers racing (e.g., quick
 *  unmount/remount) collapse to one network request. */
function scheduleRefresh(key: string, entry: CacheEntry): void {
  clearRefreshTimer(key);
  const delay = entry.expiresAt - Date.now() - REFRESH_BUFFER_MS;
  // If the URL is already within the refresh buffer (or past it), don't
  // schedule — the next mount/render will trigger an immediate refetch
  // through the normal path.
  if (delay <= 0) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(key);
    // No subscribers left → drop. The next mount will refetch on demand.
    if (!subscribers.has(key) || subscribers.get(key)!.size === 0) return;
    fetchSignedUrl(key).catch(() => {
      // Silent — consumers will get a fresh fetch on next mount/key change
      // if they're still watching. We intentionally don't surface this to
      // setState because the existing URL is still valid for ~REFRESH_BUFFER_MS;
      // a transient network blip on the background refresh shouldn't flash
      // an error to the user. If the next consumer access lands AFTER the
      // URL actually expires, the normal mount path will retry and surface
      // the error then.
    });
  }, delay);
  refreshTimers.set(key, timer);
}

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
    // Notify before scheduling so subscribers update synchronously and the
    // next render sees the fresh URL; the timer is purely for the future.
    notifySubscribers(key, entry);
    scheduleRefresh(key, entry);
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

  // Track the latest setter via ref so the subscriber callback always
  // closes over the current setState identity. (React guarantees setState
  // is stable across renders, but the ref makes the indirection explicit.)
  const setStateRef = useRef(setState);
  setStateRef.current = setState;

  useEffect(() => {
    if (!key) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    let cancelled = false;

    // Subscribe to cache updates for this key. Any other mounted consumer
    // (or the background refresh timer) that writes a fresh entry will
    // notify this subscriber, and this hook re-renders with the new URL.
    // No need for the consumer to do anything — useImageUrl(key) just keeps
    // returning a valid URL silently across the URL's whole lifetime.
    const sub: Subscriber = (entry) => {
      if (cancelled) return;
      setStateRef.current({ url: entry.url, loading: false, error: null });
    };
    let set = subscribers.get(key);
    if (!set) {
      set = new Set();
      subscribers.set(key, set);
    }
    set.add(sub);

    const cached = cache.get(key);
    const fresh = cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS;
    if (fresh) {
      setState({ url: cached.url, loading: false, error: null });
      // Make sure a refresh timer exists for this key — covers the case
      // where the cache was warmed by a previous mount that has since
      // unmounted (clearing its own timer below). Idempotent: if a timer
      // already exists, scheduleRefresh clears + replaces it with the
      // same delay so the net effect is a no-op.
      if (!refreshTimers.has(key)) {
        scheduleRefresh(key, cached);
      }
    } else {
      setState((prev) => ({
        url: prev.url ?? cached?.url ?? null,
        loading: true,
        error: null,
      }));

      fetchSignedUrl(key)
        .then((entry) => {
          if (cancelled) return;
          // notifySubscribers already updated us via the subscription
          // above, but call setState here too so the very first mount
          // (which subscribed AFTER the inflight promise might have
          // resolved) doesn't miss the update. Setting twice with the
          // same value is a React no-op.
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
    }

    return () => {
      cancelled = true;
      const s = subscribers.get(key);
      if (s) {
        s.delete(sub);
        if (s.size === 0) {
          subscribers.delete(key);
          // Last subscriber for this key just unmounted — clear the
          // background refresh timer too. The cached entry stays in the
          // cache (a quick remount can reuse it without re-fetching),
          // but we don't keep a setTimeout alive for an image nobody is
          // watching. If something remounts later, the mount path will
          // re-schedule from the cached entry's existing expiresAt.
          clearRefreshTimer(key);
        }
      }
    };
  }, [key]);

  return state;
}
