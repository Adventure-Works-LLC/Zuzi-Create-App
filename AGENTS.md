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

The user input is **exclusively four preset checkboxes** — `Color`, `Composition`,
`Lighting`, `Background` — multi-select 0..4. There is **no free-text prompt field**.
This is a hard product invariant: a description field would push the tool from "make
this beautiful" toward "do what I say," which is the wrong product. Anyone tempted to
add a description input as "just one more knob" should re-read this paragraph and the
plan's reference docs first.

The checkboxes determine the prompt via `lib/gemini/imagePrompts.ts buildPrompt()`:
  - **Empty** (no checkboxes) → freeform "make this beautiful" — the validated v0
    prompt: vary colors, preserve everything else. This is Zuzi's smoke-validated default.
  - **One or more** → vary the listed aspects, preserve the rest. The builder removes
    each varied aspect from the preserve list (e.g. `lighting` removes both "lighting"
    and "value structure" because lighting drives values).
  - **All four** → vary everything except identity-defining brushwork, drawing style,
    marks, subject, and level of finish.

The preset-set is rendered into the prompt in **fixed canonical order**
(color → composition → lighting → background) regardless of UI click order, so a given
set always produces the same prompt and the prompt cache stays stable.

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
<!-- END:zuzi-studio-guardrails -->
