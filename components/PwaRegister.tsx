"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js once on mount. Without a service worker, iOS treats
 * "Add to Home Screen" as a glorified bookmark instead of a real PWA install
 * (no splash, no standalone status bar).
 *
 * The SW itself is a no-op (see public/sw.js) — it exists for the iOS install
 * heuristic, not for caching.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        // Non-fatal — site still works without a SW.
        console.warn("[pwa] service worker registration failed:", err);
      });
  }, []);
  return null;
}
