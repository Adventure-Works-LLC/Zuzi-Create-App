/**
 * Postbuild step for `output: 'standalone'`.
 *
 * Next's standalone output deliberately does NOT include `public/` or
 * `.next/static/` — the official deploy pattern is a Dockerfile that
 * `COPY`s them in alongside the standalone tree. Railway's Railpack does
 * something similar automatically when it detects standalone mode, but
 * (a) we want `npm start` to work locally without Railway, and (b) we
 * shouldn't rely on undocumented Railpack behavior to ship code.
 *
 * After `next build` produces `.next/standalone/`, this script:
 *   1. Copies `.next/static/`  → `.next/standalone/.next/static/`
 *      (these are the content-hashed JS/CSS/font/image bundles served from
 *      `/_next/static/*` — without them every page is broken).
 *   2. Copies `public/`        → `.next/standalone/public/`
 *      (manifest, icons, splash images, the SW that `stamp:sw` just wrote).
 *
 * Idempotent: re-runs overwrite. No-op if `.next/standalone/` doesn't exist
 * (in which case the build wasn't a standalone build — log + exit 0).
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const STANDALONE = resolve(".next/standalone");
const STATIC_SRC = resolve(".next/static");
const STATIC_DST = resolve(STANDALONE, ".next/static");
const PUBLIC_SRC = resolve("public");
const PUBLIC_DST = resolve(STANDALONE, "public");

if (!existsSync(STANDALONE)) {
  console.log(
    "[setup-standalone] no .next/standalone — non-standalone build, skipping",
  );
  process.exit(0);
}

if (!existsSync(STATIC_SRC)) {
  console.error(
    `[setup-standalone] FAIL — ${STATIC_SRC} missing; run 'next build' first`,
  );
  process.exit(1);
}

// Scrub local dev state that Next's tracer sometimes pulls into standalone
// because it resolves literal path defaults like "./data/zuzi.db" inside our
// db/recovery code. Production reads/writes the same paths against Railway's
// Volume mount; we don't want any local SQLite snapshot or recovery.jsonl
// from a dev session leaking into the deployed image. Excluding via
// `outputFileTracingExcludes` in next.config.ts didn't reliably match in
// Next 16, hence this defensive scrub.
const SCRUB_DIRS = ["data", "samples", "tmp"];
for (const d of SCRUB_DIRS) {
  const target = resolve(STANDALONE, d);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`[setup-standalone] scrubbed ${target}`);
  }
}

cpSync(STATIC_SRC, STATIC_DST, { recursive: true });
console.log(`[setup-standalone] copied ${STATIC_SRC} → ${STATIC_DST}`);

if (existsSync(PUBLIC_SRC)) {
  cpSync(PUBLIC_SRC, PUBLIC_DST, { recursive: true });
  console.log(`[setup-standalone] copied ${PUBLIC_SRC} → ${PUBLIC_DST}`);
} else {
  console.warn(
    `[setup-standalone] no public/ in repo root — service worker / PWA assets won't be served`,
  );
}

console.log("[setup-standalone] done");
