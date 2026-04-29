/**
 * Minimal service worker — exists so iOS treats "Add to Home Screen" as a full PWA
 * install (with splash/standalone behavior) rather than a glorified bookmark.
 *
 * Deliberately does NOT cache HTML or API responses. Cache-Control on R2 is
 * `public, max-age=31536000, immutable`, so signed-URL image fetches are already
 * efficiently cached by the browser. App shell HTML stays fresh on every load.
 *
 * If we add offline support later, this is the file to expand. For v1 it's a
 * pass-through.
 */
self.addEventListener("install", (event) => {
  // Activate the new SW as soon as it installs (no waiting for tabs to close).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler — the browser handles all requests normally. iOS still treats
// us as a PWA because a SW is registered.
