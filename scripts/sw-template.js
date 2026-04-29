/**
 * Service worker — iteration-phase caching strategy.
 *
 * SOURCE TEMPLATE. Do NOT edit `public/sw.js` directly — it's generated from
 * this file by `scripts/stamp-sw.ts` at build time, with `__BUILD_SHA__`
 * substituted for the deploy's git SHA. Edit this file and re-run
 * `npm run stamp:sw` (or just `npm run build`).
 *
 * Strategy (correctness > performance, while we're tuning prompts):
 *
 *   1. HTML navigations & /api/* → NOT INTERCEPTED. Browser fetches normally.
 *      That's network-first with no cache fallback per the requirement —
 *      `/`, `/login`, and every `/api/*` always hit the network. If offline,
 *      the user sees the browser's standard offline state, not stale code.
 *
 *   2. /_next/static/* (Next's content-hashed bundles) → CACHE-FIRST.
 *      Filenames change when bundles change, so cache hits are always for
 *      the right version. New deploys get fresh URLs → fresh fetches → SW
 *      caches the new bundles, the activate handler garbage-collects the
 *      old cache.
 *
 *   3. Static assets in /public (icons, splash images, manifest) →
 *      STALE-WHILE-REVALIDATE. Instant load from cache; background fetch
 *      updates for next time. Acceptable to be one-deploy-stale on these
 *      since they rarely change during iteration.
 *
 *   4. On `activate`: claim all clients (so the new SW takes over open tabs
 *      immediately) and DELETE every cache that doesn't carry the current
 *      VERSION_TAG. This is what makes the iPad PWA pick up new deploys
 *      without a manual home-screen icon clear — when the new SW activates,
 *      old caches die and the page reloads against fresh resources.
 *
 *   5. VERSION_TAG embeds the deploy's git SHA, so every Railway deploy
 *      gets a unique cache namespace. Old SW's caches never collide with
 *      new SW's caches.
 *
 * When we exit iteration phase and ship to Zuzi, revisit: HTML can become
 * SWR with a short TTL, /api/image-url can be cache-first (signed URLs are
 * already cached server-side via Cache-Control headers on R2). For now,
 * stale code is unacceptable — every refresh sees fresh.
 */

// Substituted by scripts/stamp-sw.ts at build time.
const BUILD_SHA = "__BUILD_SHA__";

// Cache namespace versioning. Bump the literal "v1" prefix here only if we
// change the cache *schema* (e.g. add a new cache bucket); the BUILD_SHA
// suffix handles per-deploy invalidation automatically.
const VERSION_TAG = `zuzi-v1-${BUILD_SHA}`;
const STATIC_CACHE = `${VERSION_TAG}-next-static`;
const ASSET_CACHE = `${VERSION_TAG}-public-assets`;

// Match /public-served static media (PWA icons, splash screens, manifest).
const PUBLIC_ASSET_RE = /\.(?:png|jpe?g|webp|svg|ico|webmanifest)$/i;

self.addEventListener("install", () => {
  // Don't wait for old tabs to close — activate as soon as the new SW is
  // installed, in concert with skipWaiting + clients.claim() below.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Take control of every open client immediately, including ones that
      // were loaded under a previous SW. Without this, an iPad PWA tab open
      // when the deploy lands keeps using the old SW until it's closed and
      // reopened. With it, the new SW's fetch handler takes over on the next
      // request.
      await self.clients.claim();

      // Garbage-collect every cache that doesn't belong to this VERSION_TAG.
      // Includes both stale caches from previous deploys (different SHA)
      // and any caches from a previous schema (different "v1" prefix).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION_TAG))
          .map((k) => caches.delete(k)),
      );
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GETs. POST/PUT/PATCH/DELETE always go to network.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // malformed URL → let the browser handle it
  }

  // Same-origin only. R2 signed URLs and any other third-party fetches go
  // straight to network (and stay out of our caches).
  if (url.origin !== self.location.origin) return;

  // /api/* → never cache. Don't intercept; let the browser fetch directly.
  if (url.pathname.startsWith("/api/")) return;

  // /_next/static/* → cache-first. Next content-hashes filenames so URL
  // identity equals content identity.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(STATIC_CACHE, request));
    return;
  }

  // Static media in /public → stale-while-revalidate.
  if (PUBLIC_ASSET_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(ASSET_CACHE, request));
    return;
  }

  // Everything else (HTML navigations, the SW itself, anything else under
  // the origin) → don't intercept. Browser does network-first by default;
  // no cache fallback per requirement #1.
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    // Clone before put — the body is a stream and can only be consumed once.
    cache.put(request, response.clone()).catch(() => {
      /* quota errors ignored — fetch result still returns to caller */
    });
  }
  return response;
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  // Serve cached instantly if present; otherwise wait for network.
  return cached || (await networkPromise) || fetch(request);
}
