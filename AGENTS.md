<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:zuzi-studio-guardrails -->
# Zuzi Studio — Project Guardrails

Durable contracts established during planning + the Prompt 0 review. Do not improvise away
from these. The plan source-of-truth is `/Users/jeff/.claude/plans/i-want-to-make-cheerful-orbit.md`.
The pinned palette is `docs/PALETTE.md`. The pinned schema is `docs/SCHEMA.md`.

## 1. Single-instance only

`lib/bus.ts` (in-process EventEmitter for SSE) and `lib/auth/rateLimit.ts` (in-memory IP
rate-limit Map) are correct ONLY on a single Railway instance. Plan §Hosting pins
Railway Hobby (single instance), so this assumption holds. If the app ever scales
horizontally, both will silently break — no error, just dropped events and bypassed limits.

When writing either file, include a top-of-file comment that names this constraint and
points to plan §Hosting.

## 2. Native modules require the Node runtime

Any Next.js Route Handler, Proxy (`proxy.ts`, formerly `middleware.ts` in Next 15), or
`instrumentation.ts` file that imports `better-sqlite3`, `sharp`, or any other native
module MUST declare:

    export const runtime = 'nodejs';

Next 16 + Turbopack defaults to the Edge runtime in some contexts; native modules silently
break under Edge. Always opt back into Node when one of these dependencies is in scope.

## 3. Output aspect ratio always equals input aspect ratio

This is a permanent invariant of the generation pipeline, not just smoke. Reframing a
painting changes its identity — the model is never allowed to choose its own output ratio.

For every image generation call:
  1. Compute the snapped ratio with `nearestSupportedAspectRatio(width, height)` from
     `lib/gemini/aspectRatio.ts` (after sharp has resized the input to its long-edge cap).
     The supported set is exactly: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
  2. Pass the snapped ratio via `config.imageConfig.aspectRatio` on the generateContent call.
  3. State the snapped ratio explicitly inside the prompt text (belt-and-suspenders) — see
     `buildPrompt({ presets, aspectRatio })` in `lib/gemini/imagePrompts.ts`.

Any image-generation entry point that calls Gemini without all three steps is a bug.

## 4. "Make this beautiful" tool — and the session loop

This is a "make this beautiful" tool. The model is given the input painting and asked to
reimagine it. Same prompt is sent on every parallel call within an iteration, temperature
default (1.0), so each call produces a different result.

**The model picks the answers.** There is no planner, no directive set, no taxonomy of
color schemes, no allowed/forbidden vocabulary. The model's creative judgment IS the
feature.

### The input language: 4 checkboxes, no description field

The user input is **exclusively four preset checkboxes** — `Color`, `Ambiance`,
`Lighting`, `Background` — multi-select 0..4. There is **no free-text prompt field**.
This is a hard product invariant: a description field would push the tool from "make
this beautiful" toward "do what I say," which is the wrong product. Anyone tempted to
add a description input as "just one more knob" should re-read this paragraph and the
plan's reference docs first.

#### Preset table (canonical reference)

| Checkbox | What changes | What's preserved |
|---|---|---|
| **Color** | Hue and palette | Drawing, marks, value structure, subject, composition, lighting, background |
| **Ambiance** | Continues the painting in her voice — extends her own brushwork, marks, level of finish into the canvas; adds elements (a small object, a mark in negative space, atmospheric depth) painted in HER style | Existing developed passages (don't repaint), composition, palette family, subject identity, brushwork voice |
| **Lighting** | Mood, shadows, light direction | Color palette, composition, brushwork, subject, background, level of finish |
| **Background** | Replaces the background with a different setting, painted in her hand (her style, her marks, her finish — NOT a generic AI-rendered background) | Foreground (figure, subject), composition, framing, palette family, lighting direction, brushwork on the subject, level of finish |

> **Composition is gone.** Composition (reframing/repositioning the subject) was tried,
> didn't match the user's actual workflow, and was removed. Ambiance (continuing the
> painting in her voice) is the operation she actually wants. **Don't add Composition
> back without explicit user request.**

#### Dominators vs composers

The four presets split into two architectural categories in `imagePrompts.ts`:

  - **Dominators**: have a dedicated multi-paragraph prompt body validated in Krea.
    When a dominator is checked, its body short-circuits the builder and any other
    checked presets are subsumed. This is intentional — dominator prompts include
    strong preserve-this-aspect language ("palette family stays identical", "composition
    stays identical") that contradicts a "vary X" composer. If Zuzi wants compound
    edits, she runs two passes (e.g. Background to swap setting → favorite a result
    → Color on the favorite to vary palette).
      - **Ambiance v8** — `AMBIANCE_PROMPT_BODY` (locked).
      - **Background v3** — `BACKGROUND_PROMPT_BODY` (locked).
  - **Composers**: participate in the templated "Reimagine X, preserve Y" path. Multiple
    composers can stack — Color + Lighting renders "Reimagine the colors and palette and
    the lighting and mood, ...". Color's solo rendering is also frozen as
    `COLOR_PROMPT_BODY` for byte-identical lock-in.
      - **Color** (solo: locked body; combined: templated).
      - **Lighting** (templated, both solo and combined). Not yet locked — when Lighting
        is iterated in Krea, it'll get the same dedicated-body treatment.

Resolution order in `buildPrompt`:
  1. `presets: []` (empty) → freeform v0 "make this beautiful".
  2. `presets` includes `ambiance` → `AMBIANCE_PROMPT_BODY`.
  3. `presets` includes `background` → `BACKGROUND_PROMPT_BODY`.
  4. `presets` is exactly `['color']` → `COLOR_PROMPT_BODY` (frozen).
  5. otherwise → templated path (Lighting solo, Color+Lighting).

If both Ambiance and Background are somehow checked simultaneously, Ambiance wins
(ordering is deliberate — Ambiance is the broader voice-continuation default).

In the templated path, the preset-set is rendered in **fixed canonical order**
(color → ambiance → lighting → background) regardless of UI click order, so a given
set always produces the same prompt and the prompt cache stays stable.

#### Cross-prompt lessons

When tuning prompts, see `docs/PROMPT_LESSONS.md` for the rules that came out of the
Ambiance and Background iteration rounds. The short version: Pro defaults to a
generic AI-rendered look for any "make it beautiful" framing; anti-language and
narrow operations and redundant style-anchoring are what get it to imitate Zuzi's
hand instead.

### Tile count

Each Submit produces N tiles. Default N = `TILE_COUNT_DEFAULT` (3). Per-iteration cap
N ≤ `TILE_COUNT_MAX` (9). Both constants live in `lib/gemini/imagePrompts.ts`. The DB
column `iterations.tile_count` records the chosen N; the worker reads it and fires that
many parallel calls.

What the prompt enforces (in the empty-presets default — preserve everything except color):
- Subject, composition, brushwork, drawing style, marks, level of finish, value structure.
- Aspect ratio matches the input exactly (also passed via `config.imageConfig.aspectRatio`
  per Section 3).

### The session loop (primary product mechanic)

The product holds **3–10 sources in flight at once**. Sources are the primary unit;
iterations belong to a source (FK `iterations.source_id`). The Studio shows a horizontal
**source strip** of active (non-archived) thumbnails; tap a source to make it current;
Generate / Refresh fire against the current source.

A typical day:

  1. Upload (or pick an existing source from the strip). Upload creates a `sources` row
     and selects it as current.
  2. **Generate** → N parallel calls fire against the current source (N defaults to 3,
     `TILE_COUNT_DEFAULT`), N tiles stream in.
  3. Zuzi favorites 0–N keepers (tap the corner star on any tile, or heart in the
     lightbox).
  4. Tap **Generate again** (Reimagine) → another N parallel calls fire against the
     SAME source. New `iterations` row, same `source_id`. Different outputs.
  5. Repeat 4–5 cycles per source, accumulating favorites.
  6. Switch to a different source in the strip. Repeat. Each source carries its own
     iteration history; favorites cross all of them.
  7. End-of-day: curated shortlist of favorites she can compare side-by-side in the
     lightbox (swipe between, 2-up, or 4-up).

**Sources can be archived** (soft delete via `sources.archived_at`). Archived sources
disappear from the active strip but their favorited tiles still appear in the global
Favorites view. This is how the strip stays uncluttered while preserving the long
history. There is no hard delete of sources in v1.

**Favorites are load-bearing, not a "Saved tab" afterthought.** The favorite
affordance lives on the grid (long-press or corner heart), in the lightbox (large
heart toggle), and the global Favorites view crosses all sources (active + archived).
The History Drawer has a **Favorites filter** at the top, plus a **This Source
filter** that scopes to runs against the current source. Together those two filters
replace the in-session Trail ribbon — there is no separate Trail UI.

**Generate-again (Reimagine) is the same button as the initial Generate**: after the
first iteration lands, tapping Generate fires another N-tile run against the same
current source. The action label is just "Generate" (no separate "Refresh" verb in the
UI per the Krea-pattern reference in `docs/UX_INSPIRATION.md`).

### CompareLightbox is load-bearing

This is the surface where Zuzi actually picks. Per her own framing, it's "the reason I
favorite in the first place." v1 must ship at minimum:
  1. **Swipe between favorites** in lightbox (filtered to favorites-only mode).
  2. **2-up side-by-side** for direct A/B comparison.

4-up grid view is nice-to-have; not a blocker for v1 ship but should land before any
public mention of the tool.

### Save to camera roll via Web Share API

Favorites need to leave the app. The Lightbox toolbar has a **Share** button that
invokes `navigator.share({ files: [File] })`. On iOS this opens the native share sheet
which natively includes "Save Image" alongside AirDrop, Messages, and her other
configured targets. Cleaner than a download link with `Content-Disposition: attachment`
because it inherits the OS's full target list.

Fallback for browsers without Web Share API support: render the image, let her
long-press → Save Image manually (iOS Safari supports this on any `<img>` regardless of
Web Share availability — graceful degradation, no extra UI required).

### No human gate in production

In production there is no gate. Zuzi taps generate; N image calls fire; tiles come back.
The smoke script in this repo runs the same way — there are no `--plan-only` /
`--from-saved` modes because there are no intermediate artifacts to review.

Every prompt evaluation must answer: "would this be acceptable if Zuzi triggered it with
no one watching, on every painting forever?" Borderline outputs are NOT a "this run"
problem to manually catch and re-roll past — they are a hole in the production prompt
that will leak into her grids on every future painting. **Tighten the prompt, then
re-run.** Don't re-roll the model hoping for a luckier draw.

### Model tier × resolution: the cost knob

Per-iteration toggles in the Studio UI: `Flash | Pro` and `1K | 4K`. Together with the
tile count (`TILE_COUNT_DEFAULT` = 3) they form a per-image × count cost surface
(verified against ai.google.dev/gemini-api/docs/pricing on 2026-04-22):

| | 1K (per image) | 4K (per image) | Default 3-tile Submit |
|---|---|---|---|
| **Flash** (`gemini-3.1-flash-image-preview`) | $0.067 | $0.101 | $0.20 (1K) / $0.30 (4K) |
| **Pro** (`gemini-3-pro-image-preview`) | $0.134 | $0.24 | $0.40 (1K) / $0.72 (4K) |

**Pro 1K is the default.** Flash is for cheap exploration on early iterations; Pro is
for refined output on keeper passes. 4K is for the final winners worth printing. The
default count of 3 (down from the old 9) makes a typical Submit roughly a third the
cost of the prior tooling.

Both `model_tier` and `resolution` are stored per-iteration in the `iterations` table.
The `IMAGE_MODEL` env var is a fallback only — the request body's `modelTier` wins. This
matters because the user toggles tier per-iteration; the env var just defines what
happens if a request ever omits the field.

Cost computation lives in `lib/cost.ts` as a function of `(model_tier, resolution,
count)` via `costFor(tier, resolution, count)` (projected pre-Submit) and
`costForCompletedIteration(tier, resolution, successfulTileCount)` (worker write to
`usage_log`). It's the only place pricing constants live in the repo. When Google
updates pricing, update `lib/cost.ts` AND the table above AND its verification date stamp.

### Cost shape under the session loop

Flash is roughly half the price of Pro at the same resolution (verified 2026-04-22). A
deep-iteration day on Pro 1K with the default 3-tile Submit = 5 generations × $0.40 =
~$2 per source. With Flash for 3 early generations (~$0.60) and Pro 1K for 2 keeper
passes (~$0.80), total ≈ $1.40 per source. The $80 cap supports many sources per day —
plenty of headroom for the typical use pattern. Leave at $80; bump if needed.

Canonical implementations:
- `lib/gemini/imagePrompts.ts` — preset-aware prompt builder + `TILE_COUNT_DEFAULT` /
  `TILE_COUNT_MAX` constants.
- `lib/cost.ts` — (model_tier, resolution) → cost lookup; the only place pricing lives.
Both used by `scripts/smoke.ts` and `lib/gemini/runIteration.ts`.

## 5. Prompt 3 build order is the contract

When building the generation pipeline (Prompt 3), follow this tier order verbatim. No
improvising the sequence — the dependencies are real and getting the order wrong forces
re-design of primitive interfaces.

  Tier A — zero-deps, parallelizable:
    1. Drizzle schema (matches docs/SCHEMA.md) + lib/db/client.ts + initial migration
    2. lib/storage/r2.ts (S3-compat client, putObject / getObjectBytes / publicUrlFor)
    3. lib/bus.ts (Map<string, EventEmitter> with emit / subscribe / unsubscribe)
    4. lib/gemini/callWithRetry.ts (1 initial + 3 retries = 4 total attempts; backoff 2s/5s/12s ± jitter on retries; retryOn=[429,500,503] plus transient network/timeout/quota classifications)
    5. lib/auth/rateLimit.ts (in-memory IP Map; 5 / 5min / IP)

  Tier B — depends on schema:
    6. lib/db/queries.ts
    7. lib/recovery.ts (append-then-update; scan tolerates trailing partial line silently)
    8. lib/auth/{password,session}.ts (bcrypt + iron-session)

  Tier C — consumes everything:
    9.  lib/gemini/runIteration.ts (the worker)
    10. app/api/iterate/route.ts (idempotency via requestId UNIQUE)
    11. app/api/iterate/[id]/stream/route.ts (subscribe-first, then DB query, dedupe by (idx, status))
    12. app/api/login/route.ts + app/api/logout/route.ts
    13. instrumentation.ts (boot sweep: markStalePendingFailed + scanAndRehydrate)
    14. Update scripts/smoke.ts to share extractImageBytes via lib/gemini/extract.ts

Also extract `extractImageBytes` from `scripts/smoke.ts` into `lib/gemini/extract.ts` early
in Prompt 3 so the worker and smoke share one parser (and one place to add safety-reason
classification).

## 6. Schema cleanup principle

If a column is dead weight in the current product shape, drop it. Schema is for what the
product needs now, not what it might need later. Restoring a column is cheap; carrying
unused columns through migrations is not.

This principle codifies a recurring lesson from the planning phase. The following columns
were carried in the schema until the product shape stabilized, then removed:
- `iterations.parent_tile_id` — DAG-of-tiles framing, never visualized in v1, removed when
  Refresh-from-same-source replaced "use as source"
- `iterations.preset_tags` (JSON), `iterations.variation_mode`, `iterations.preset_tag`,
  `iterations.prompt_text` — planner-era columns, removed when the planner was killed
- `tiles.prompt_used` — single shared prompt means every tile in an iteration carries the
  same string; the column was duplicating immutable data, removed

Apply when adding columns too. "We might need this later" is not a reason. The reason has
to be "the current product shape requires this column right now." If you can't name the
read-or-write path that uses it in the current code, leave it out.

## 7. Infrastructure

Pinned values for external services. Do NOT put any of these in committed env files —
paste them into local `.env` (and into Railway sealed env vars when those exist).

### Cloudflare R2 — privacy model

**Both buckets are PRIVATE.** There is no public URL. All image access goes through
`GET /api/image-url?key=<r2-key>` which returns a presigned URL valid for 1 hour
(default; tunable per call via `signedUrlFor(key, ttlSeconds)` in `lib/storage/r2.ts`).

| Bucket | Visibility | Purpose |
|---|---|---|
| `zuzi-images` | Private | Source uploads, generated outputs, thumbnails (`inputs/`, `outputs/`, `thumbs/`) |
| `zuzi-backups` | Private | Nightly SQLite + recovery.jsonl backups (Prompt 6) |

Env var values:
- `R2_BUCKET` = `zuzi-images`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY` — issued by Cloudflare; rotate when needed
- `R2_BACKUP_BUCKET` = `zuzi-backups`
- `R2_BACKUP_KEY`, `R2_BACKUP_SECRET` — separate credentials scoped to the backup bucket

There is no `R2_PUBLIC_HOST` env var. (Earlier drafts had one for the `pub-<hash>.r2.dev`
hostname; that was removed when the bucket flipped to private.)

### Threat model — signed URLs

`GET /api/image-url` issues 1-hour presigned URLs and is **auth-gated at issuance**:
only authenticated sessions can request a URL. Once issued, the URL is bearer-style and
works for its TTL **even without a session** — anyone who obtains the URL within the
window can fetch the image.

Mitigations in place:
1. **1-hour TTL** bounds the leak window. Configurable per call site.
2. **Auth-gated issuance** — no anonymous access to the URL endpoint.
3. **No public bucket discovery** — keys are ulid-based and unguessable.
4. **No URL persistence on the server** — keys are stored in the DB; URLs are computed
   on demand.
5. **No URL persistence on the client** — `hooks/useImageUrl.ts` keeps a module-scoped
   in-memory `Map` (one cache per tab). Reload = fresh fetches. No localStorage,
   sessionStorage, IndexedDB, or service-worker cache of signed URLs.
6. **Path-traversal defense at the route** — `/api/image-url` only signs keys starting
   with `inputs/`, `outputs/`, or `thumbs/`. `..` and `\` are rejected. Max key length
   256 chars.

For a single-user app where the adversary is "someone who casually obtains a leaked
URL", this is the right tradeoff — convenience (no proxy bandwidth on Railway, browsers
cache via the URL) without putting the bucket on the open internet. Re-evaluate if the
user base ever grows beyond 1, or if leak risk profile changes (e.g., shared screen
during a stream).

### Railway

- App URL: Railway-issued `*.up.railway.app` subdomain (assigned at first deploy; see plan §"Decisions Confirmed").
- Custom domain: deferred to v2.
- iPad PWA "Add to Home Screen" makes the URL invisible after day one — see §4 ITP note.

### `.env` gotcha

Next.js loads `.env` via `@next/env`, which runs dotenv-expand. **Bcrypt hashes contain
`$` characters that get consumed as variable references** and silently mangled (e.g.,
`$2b$12$abcd...` → `abcd...`). Single-quoting does NOT prevent this. Backslash-escape
every `$` in `.env`:

    ZUZI_PASSWORD_HASH=\$2b\$12\$abc...     # OK (works in @next/env)
    ZUZI_PASSWORD_HASH='$2b$12$abc...'      # BROKEN (mangled by dotenv-expand)

Railway sealed env vars do NOT need escaping (Railway doesn't run dotenv-expand).
`scripts/hash-password.ts` emits both forms — bare hash to stdout (Railway), escaped form
to stderr (local `.env`). When generating a new hash, paste from the right stream.

## 8. Build & deploy infrastructure

The deploy path is non-obvious enough that getting it wrong has already broken
production once and almost broken it three more times. Pin the rules here.

### Railway uses our Dockerfile, not Railpack

Repo-root `Dockerfile` overrides Railway's Railpack auto-detection. **Don't
delete the Dockerfile.** Railpack's auto-deploy for a Next.js project ships
the entire post-build `/app` (sources + node_modules with devDependencies +
both `.next/` and `.next/standalone/`) as a ~276MB image. The whole point of
`output: 'standalone'` is to deploy ONLY the lean subset onto a fresh runtime
base; that requires an explicit two-stage Docker build.

Other implicit Railway behaviors that bit us:
  - **Railpack silently injects Railway env vars into the build container.**
    Our explicit Dockerfile does NOT (and shouldn't — build args end up cached
    in image layers and visible to anyone who can pull the image; runtime
    secrets belong in the runner stage's environment, not the build's).
    Module-load-time env reads were latent under Railpack and broke under
    the Dockerfile — see §9 below.
  - **Railway's Start Command in the dashboard overrides Dockerfile `CMD`.**
    Both must agree. Today both run `node server.js` (CMD relative to
    WORKDIR `/app`; package.json `"start"` relative to runner cwd which is
    also `/app`). If you change one, change the other.
  - **Railway's Volume at `/data` is mounted root:root.** The runner stage
    runs as root for that reason — see §8.4 below.

### Multi-stage standalone pattern (what the Dockerfile does)

Builder stage on `node:22-alpine`:
  - `apk add python3 make g++ libc6-compat` — native module compile prereqs
    (better-sqlite3 build, sharp prebuild fallback).
  - `npm ci` — full deps incl. devDeps. Needed for the build chain (tsx for
    check:prompts and stamp:sw, drizzle-kit if anyone runs it inside, etc.).
  - `ARG RAILWAY_GIT_COMMIT_SHA` → `ENV` so `scripts/stamp-sw.ts` substitutes
    it into the SW.
  - `RUN npm run build` runs the full chain documented in §10.

Runner stage on a fresh `node:22-alpine`:
  - `apk add libc6-compat` — runtime shim for prebuilt Linux binaries.
  - `COPY --from=builder /app/.next/standalone ./` unpacks the standalone
    contents directly into `/app/`. Important: the contents land at `/app/`,
    NOT at `/app/.next/standalone/`. Server.js is at `/app/server.js`.
  - `CMD ["node", "server.js"]`.

Final image ~80–110MB (alpine base + libc6-compat + ~47MB standalone tree).

### `outputFileTracingIncludes` + the writeStandaloneDirectory env-copy gotcha

`next.config.ts`:
  - `outputFileTracingIncludes: { "/": ["./drizzle/**/*"] }` forces SQL
    migration files into the standalone bundle. They're read at runtime by
    the migrator but aren't in the JS module graph, so the tracer wouldn't
    see them otherwise.
  - `outputFileTracingExcludes` lists `data/`, `samples/`, `.claude/`, `tmp/`
    defensively. Pattern matching is fiddly across Next versions; combine
    with an explicit scrub in `scripts/setup-standalone.mjs`.

The big surprise: **Next 16's `writeStandaloneDirectory` hardcodes a copy of
`.env` and `.env.production` into `.next/standalone/`** regardless of what
config you set. Production is unaffected (the Dockerfile builder context
excludes `.env*` via `.dockerignore`, so there's no `.env` to copy). But
**local `npm run build` produces `.next/standalone/.env` containing live
secrets.** The scrub in `setup-standalone.mjs` handles this — keep it
working if you ever rewrite that script.

### Run as root in the runner stage

The runner stage has NO `USER` directive. The container runs as root.

Reasons:
  - Railway's Volume mount at `/data` is `root:root`. SQLite needs write
    access to BOTH the .db file AND its parent directory (for WAL/SHM
    sidecar files). A non-root user gets "attempt to write a readonly
    database" on the first write — manifested originally as a `[boot] sweep
    failed` log line because migrations were a no-op (schema already current
    from prior root-uid deploys) so the readonly error fired in the first
    real write.
  - Can't `chmod` `/data` from a startup hook because only root can chmod a
    root-owned dir, and once we're running as root the original "drop
    privileges" reason is gone.
  - Can't move SQLite off `/data` because `/data` is the only persistent
    path on Railway.

Threat model: single-tenant Railway service, password-gated, one process per
container. The trust boundary is the container, not the in-container user.

### Build chain + local verification

`npm run build` is `check:prompts && stamp:sw && next build && setup-
standalone.mjs`. Each step gates the next:
  - `check:prompts` (§10) fails → prompt regression detected; stop.
  - `stamp:sw` writes `public/sw.js` with the deploy SHA (§9).
  - `next build` produces `.next/standalone/`.
  - `setup-standalone.mjs` copies `.next/static/` and `public/` into the
    standalone tree (Next deliberately doesn't auto-copy these), and scrubs
    `data/`, `samples/`, `tmp/`, and any `.env*` that snuck in.

To simulate the Docker builder's environment locally (no env vars at all,
clean shell):

```
env -i HOME=$HOME PATH=$PATH NEXT_TELEMETRY_DISABLED=1 npx next build
```

If this fails, the Docker build will fail. If it passes, the Docker build
will pass for the same reasons. Use this to test any change touching
module-load-time code.

To simulate the runner stage's filesystem layout locally (after a build):

```
cd .next/standalone && DATABASE_URL=file:/tmp/test.db SESSION_SECRET=... npm start
```

Or from repo root: `npm run start:standalone` does the equivalent.

## 9. Module-load-time hygiene (preventing build-time crashes)

Next's page-data collection imports every Route Handler module during build.
**Anything at top level (module scope, not inside a function) that requires
runtime env vars or external resources will crash the build.** This is what
broke commit `1769582`'s deploy: `lib/gemini/client.ts` had a top-level
`if (!process.env.GEMINI_API_KEY) throw …` and a top-level `new GoogleGenAI(…)`.
Under Railpack auto-detection the env was silently injected into the build
container, masking the bug; under the explicit Dockerfile it surfaced.

### The pattern

Use a lazy singleton with a getter function:

```ts
let _client: SomeSDK | null = null;
export function getClient(): SomeSDK {
  if (_client) return _client;
  const key = process.env.SOME_KEY;
  if (!key) throw new Error("SOME_KEY missing. ...");
  _client = new SomeSDK({ key });
  return _client;
}
```

Module-load is a no-op. Errors fire only at the first call site, which is
always inside a request handler, the worker, or a script — all of which
run after env is loaded.

### Existing examples (audit them when adding similar code)

  - `lib/storage/r2.ts` — `let _client = null; function client() { ... }`
  - `lib/db/client.ts` — `init()` deferred from `db()` / `sqlite()` getters
  - `lib/gemini/client.ts` — `genai()` getter (the most recent convert)
  - `lib/auth/session.ts` — env read inside `sessionOptions()` called from
    `getSession()`
  - `lib/auth/password.ts` — env read inside `verifyPassword()`
  - `lib/recovery.ts` — env read inside `recoveryPath()`

### Anti-patterns (causes a build crash)

  - `if (!process.env.X) throw new Error(...)` at top level
  - `export const client = new SomeSDK({ apiKey: process.env.X })` at top
    level
  - `const COMPUTED = doSomethingWithEnv()` at top level if `do…` reads
    env without a default

Default fallbacks (`process.env.X ?? "fallback"`) are fine at top level —
they don't throw. Validation that requires the value to be set must move
inside the getter.

When you add a new client / external SDK / env-derived constant, audit its
import chain against this rule. The build-time check `npm run build` from
a no-env shell (§8.5) will catch violations.

## 10. Build-time prompt regression guard

`scripts/check-prompts.ts` runs as the first step of `npm run build`. It:
  1. Renders all 16 preset combinations × 4 representative aspect ratios
     and asserts each produces a non-empty string with the literal aspect
     ratio interpolated into the canonical sentence.
  2. Runs 9 canary substring checks against the locked prompt bodies —
     opening sentences and load-bearing anchors:
       - v0 freeform: `"Reimagine it with new colors"`
       - Ambiance v8: opens `"Continue this painting in the same style…"`
         and contains `"HER style"`
       - Background v3: opens `"This painting needs a different background
         environment."` and contains `"AI-illustration finish"`
       - Color frozen body: `"Reimagine the colors and palette"`
  3. Verifies dominator routing — `['color','ambiance']` → Ambiance,
     `['lighting','background']` → Background, all-four → Ambiance.

Why this exists: commit `088b3f9` locked Ambiance v8, **the Railway build
silently failed**, the next successful deploy carried v8 along but for
several hours production served the prior v1-style Ambiance. A green build
log alone is no longer a sufficient signal that the locked prompts are
actually shipping. The guard fails the build (exit 1, skipping `next build`)
if anything regresses, so a deploy that gets past it has prompts intact.

**If you change a locked prompt body, update the matching canary string in
`scripts/check-prompts.ts` in lockstep.** That double-edit is the lock —
making the canary update explicit prevents silent paraphrase. See
`docs/PROMPT_LESSONS.md` for the iteration history of each locked body.

## 11. Service worker — iteration-phase caching strategy

`scripts/sw-template.js` → stamped at build time by `scripts/stamp-sw.ts`
into `public/sw.js`. Strategy:

  - **HTML navigations** → not intercepted (browser network-first, no cache
    fallback). `/login`, `/`, every page always hits fresh. Stale code on
    iPad PWA was the original pain.
  - **`/api/*`** → not intercepted. Always network.
  - **`/_next/static/*`** → cache-first. Next content-hashes filenames so
    URL identity == content identity; cache hits are always for the right
    bundle.
  - **`/public/*` static assets** (icons, splash, manifest) → stale-while-
    revalidate. Instant load + background update.
  - **On `activate`** → `clients.claim()` (open PWA tabs adopt the new SW
    immediately) and DELETE every cache that doesn't carry the current
    `VERSION_TAG`. This is what makes iPad PWA tabs pick up new deploys
    without manual home-screen icon clear.
  - **`VERSION_TAG`** = `zuzi-v1-<RAILWAY_GIT_COMMIT_SHA[:12]>`. Per-deploy
    cache namespace, no collisions across deploys.

`PwaRegister.tsx` registers the SW only in `NODE_ENV=production`. Dev mode
serves `/_next/*` URLs without content hashes (they change on every HMR
rebuild), so cache-first behavior would silently break HMR.

**Watch-out**: the SW cache invalidation depends on Railway passing
`RAILWAY_GIT_COMMIT_SHA` as a `--build-arg` to `docker build`. If it
doesn't, `stamp-sw.ts` falls back to `git rev-parse HEAD` (which fails
because `.git` is excluded from the Docker build context) and ultimately
to the literal string `"dev"`. Every deploy then stamps the same cache key
and the SW stops invalidating. Verify after a deploy by inspecting the
deployed `/sw.js` and confirming `BUILD_SHA` matches the deploy SHA.

When the project exits iteration phase and ships to a real user base, this
strategy can be relaxed (HTML SWR with short TTL, etc.) — but until then,
correctness > performance and stale code is unacceptable.

## 12. Tile-width invariant — viewport-driven, not count-driven

`components/krea/IterationRow.tsx`. Tile width is determined by VIEWPORT,
NEVER by tile count. Generating 1 tile renders one tile at canonical width
with empty space to its right; generating 3 fills the row at the same width;
generating more wraps at the same width. **Do not** use `grid-cols-1` /
`grid-cols-2` / `grid-cols-3` based on count — that stretches a 1-tile run
into a banner.

Single CSS clamp covers all iPad targets:

```ts
width: "clamp(218px, calc((100vw - 88px) / 3), 358px)"
```

Math: `88 = 64` (px-8 padding × 2) `+ 24` (two 12px gaps between three
tiles). The 218px floor keeps 3-up working on iPad mini portrait (744 wide
viewport, ~680 inner; 3*218+24 = 678 fits with 2px to spare). The 358px
ceiling caps at the max width that fits 3-up inside the TileStream's
`max-w-[1100px]` container (3*358+24 = 1098 ≤ 1100). 360 overflows by 4px
and wraps the third tile to row 2 — verified empirically. Do not bump.

Inline `style` attribute, not a Tailwind arbitrary-value class — nested
calc() inside clamp() inside `w-[...]` trips the JIT in Tailwind 4.

## 13. When changing this file

  - If you're adding a new architectural contract: add a numbered section
    at the bottom. Keep each section focused on one durable rule.
  - If you're updating an existing section: keep the cross-references intact
    (search for `§N` and `docs/...md` and verify the linked content still
    matches).
  - The file lives behind `CLAUDE.md` (which is `@AGENTS.md`). Updating
    AGENTS.md updates what every Claude session in this repo sees as
    project instructions. Treat changes here as load-bearing.
<!-- END:zuzi-studio-guardrails -->
