/**
 * Stamp the deploy's git SHA into `public/sw.js` so the service worker's
 * cache namespace is unique per deploy. Run by `npm run build` (gates
 * Railway deploys) and by `npm run predev` (so local dev has a valid SW
 * registered).
 *
 * Source: `scripts/sw-template.js` with `__BUILD_SHA__` placeholder.
 * Output: `public/sw.js` with placeholder substituted.
 *
 * SHA source priority:
 *   1. `RAILWAY_GIT_COMMIT_SHA` env var (set automatically by Railway).
 *   2. `git rev-parse HEAD` (local checkouts).
 *   3. fallback "dev" (envs without git, e.g. shallow CI runners).
 *
 * Idempotent: same SHA → byte-identical output. Safe to run repeatedly.
 *
 * `public/sw.js` is gitignored — it's a build artifact, regenerated every
 * time. Edit `scripts/sw-template.js` to change SW behavior.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATE = resolve("scripts/sw-template.js");
const OUTPUT = resolve("public/sw.js");
const PLACEHOLDER = "__BUILD_SHA__";

function resolveSha(): { full: string; source: string } {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv && fromEnv.length > 0) {
    return { full: fromEnv, source: "RAILWAY_GIT_COMMIT_SHA" };
  }
  try {
    const sha = execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return { full: sha, source: "git rev-parse HEAD" };
  } catch {
    /* fall through */
  }
  return { full: "dev", source: "fallback" };
}

const { full, source } = resolveSha();
const shortSha = full.slice(0, 12);

const template = readFileSync(TEMPLATE, "utf8");
if (!template.includes(PLACEHOLDER)) {
  console.error(
    `[stamp-sw] FAIL — template at ${TEMPLATE} contains no ${PLACEHOLDER} placeholder.\n` +
      `         The stamper would produce identical output regardless of deploy, defeating cache invalidation.\n` +
      `         Restore the placeholder in the BUILD_SHA constant declaration.`,
  );
  process.exit(1);
}
const stamped = template.split(PLACEHOLDER).join(shortSha);

writeFileSync(OUTPUT, stamped);
console.log(
  `[stamp-sw] wrote ${OUTPUT} with sha=${shortSha} (source: ${source})`,
);
