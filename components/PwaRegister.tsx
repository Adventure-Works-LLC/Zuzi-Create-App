"use client";

import { useEffect } from "react";

/**
 * Registers `/sw.js` once on mount, in production builds only.
 *
 * The SW (generated from `scripts/sw-template.js` per deploy) does two
 * things:
 *   1. Lets iOS treat "Add to Home Screen" as a real PWA install (splash,
 *      standalone status bar) rather than a glorified bookmark — the iOS
 *      install heuristic checks for an active SW.
 *   2. Manages caching during product iteration: HTML and `/api/*` always
 *      hit the network, `/_next/static/*` is cache-first (Next content-
 *      hashes filenames so URL identity == content identity), public
 *      assets are stale-while-revalidate. On every deploy the cache key
 *      changes (it embeds the build SHA) and the activate handler wipes
 *      old caches + claims open clients, so iPad PWA tabs pick up new
 *      deploys on the next refresh — no manual home-screen icon clear.
 *
 * In development we DON'T register, because Next.js dev mode serves
 * `/_next/...` URLs that change on every HMR rebuild but don't carry a
 * content hash. Cache-first behavior would break HMR in subtle ways. Use
 * `npm run start` after `npm run build` to test SW behavior locally.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        // Non-fatal — site still works without a SW.
        console.warn("[pwa] service worker registration failed:", err);
      });
  }, []);
  return null;
}
