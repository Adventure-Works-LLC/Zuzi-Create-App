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
     `buildImagePrompt(aspectRatio)` in `lib/gemini/imagePrompt.ts`.

Any image-generation entry point that calls Gemini without all three steps is a bug.

## 4. "Make this beautiful" tool — and the session loop

This is a "make this beautiful" tool. The model is given the input painting and asked to
reimagine it with new colors of its own choosing. Same prompt sent on 9 parallel calls,
temperature default (1.0), so each call produces a different result.

**The model picks the colors.** There is no planner, no directive set, no taxonomy of
color schemes, no allowed/forbidden vocabulary. The model's creative judgment IS the
feature.

What the prompt enforces (preserve everything except color):
- Subject, composition, brushwork, drawing style, marks, level of finish, value structure.
- Aspect ratio matches the input exactly (also passed via `config.imageConfig.aspectRatio`
  per Section 3).

### The session loop (primary product mechanic)

A single session against one source painting:

  1. Upload (or use existing) source painting.
  2. **Generate** → 9 parallel calls fire, 9 tiles stream in.
  3. Zuzi favorites 0–3 keepers (long-press a tile, or heart icon corner-tap, or favorite
     button in the lightbox).
  4. Tap **Refresh / Generate again** → another 9 parallel calls fire against the SAME
     source, same prompt. New `iterations` row, new 9 tiles, model produces different
     results.
  5. Repeat 4–5 cycles, accumulating favorites.
  6. End with a curated shortlist of ~5–15 favorited tiles she can compare side-by-side
     in the lightbox (2-up or 4-up).

**Favorites are primary, not a "Saved tab" afterthought.** The favorite affordance lives
both on the grid (persistent visual mark — accent ring or filled heart on the tile) and
in the lightbox (large heart toggle in the toolbar). The History Drawer has a
**Favorites filter** at the top, plus a **This Source filter** that scopes to all runs
against the current input painting. Together those two filters are the "Trail" — there
is no separate Trail ribbon UI.

**Refresh is a primary action**, equal weight with the original Generate button after the
first generation has landed. Same source, same prompt, new `iterations` row sharing the
same `input_image_key`. This shape lets the History Drawer show "5 runs against this
source, 47 total tiles, 8 favorited."

**Lightbox 2-up / 4-up compare** is in v1 scope. Artists pick by comparing, not by
looking at one tile in isolation. v1 implementation: when filtered to favorites in the
History Drawer, tapping a favorite opens the lightbox in compare mode — swipe between
favorites only, with the source image pinned at the top of the screen.

### No human gate in production

In production there is no gate. Zuzi taps generate; 9 image calls fire; tiles come back.
The smoke script in this repo runs the same way — there are no `--plan-only` /
`--from-saved` modes because there are no intermediate artifacts to review.

Every prompt evaluation must answer: "would this be acceptable if Zuzi triggered it with
no one watching, on every painting forever?" Borderline outputs are NOT a "this run"
problem to manually catch and re-roll past — they are a hole in the production prompt
that will leak into her grids on every future painting. **Tighten the prompt, then
re-run.** Don't re-roll the model hoping for a luckier draw.

### Model tier × resolution: the cost knob

Per-iteration toggles in the Studio UI: `Flash | Pro` and `1K | 4K`. Together they form
a 2×2 cost matrix (verified against ai.google.dev/gemini-api/docs/pricing on 2026-04-22):

| | 1K | 4K |
|---|---|---|
| **Flash** (`gemini-3.1-flash-image-preview`) | $0.067/img · $0.603/grid | $0.101/img · $0.909/grid |
| **Pro** (`gemini-3-pro-image-preview`) | $0.134/img · $1.21/grid | $0.24/img · $2.16/grid |

**Pro 1K is the default.** Flash is for cheap exploration on early refreshes; Pro is
for refined output on keeper passes. 4K is for the final winners worth printing.

Both `model_tier` and `resolution` are stored per-iteration in the `iterations` table.
The `IMAGE_MODEL` env var is a fallback only — the request body's `modelTier` wins. This
matters because the user toggles tier per-iteration; the env var just defines what
happens if a request ever omits the field.

Cost computation lives in `lib/cost.ts` as a function of `(model_tier, resolution)` —
the only place pricing constants live in the repo. When Google updates pricing, update
`lib/cost.ts` AND the table above AND its verification date stamp.

### Cost shape under the session loop

Flash is roughly half the price of Pro at the same resolution (not 3.4× cheaper as
initially estimated — pricing was verified 2026-04-22 and corrected). A deep-iteration
day on Pro 1K = 5 refreshes × $1.21 = ~$6 per source painting. With Flash for 3 early
refreshes (~$1.81) and Pro 1K for 2 keeper passes (~$2.42), total ≈ $4.23 per source.
The $80 cap supports ~13 all-Pro days, ~19 mixed days. Leave at $80; bump if needed.

Canonical implementations:
- `lib/gemini/imagePrompt.ts` — single shared prompt template.
- `lib/cost.ts` — (model_tier, resolution) → cost lookup; the only place pricing lives.
Both used by `scripts/smoke.ts` and (in Prompt 3) by `lib/gemini/runIteration.ts`.

## 5. Prompt 3 build order is the contract

When building the generation pipeline (Prompt 3), follow this tier order verbatim. No
improvising the sequence — the dependencies are real and getting the order wrong forces
re-design of primitive interfaces.

  Tier A — zero-deps, parallelizable:
    1. Drizzle schema (matches docs/SCHEMA.md) + lib/db/client.ts + initial migration
    2. lib/storage/r2.ts (S3-compat client, putObject / getObjectBytes / publicUrlFor)
    3. lib/bus.ts (Map<string, EventEmitter> with emit / subscribe / unsubscribe)
    4. lib/gemini/callWithRetry.ts (3 attempts, exponential 2s/5s/12s + jitter, retryOn=[429,500,503])
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

### Cloudflare R2

| Bucket | Visibility | Purpose | Public URL |
|---|---|---|---|
| `zuzi-images` | Public | Source uploads, generated outputs, thumbnails (`inputs/`, `outputs/`, `thumbs/`) | `https://pub-00ea5347e7c44125bbf6d96839b774b7.r2.dev` |
| `zuzi-backups` | Private | Nightly SQLite + recovery.jsonl backups (Prompt 6) | (none — accessed via S3 API only) |

Env var values:
- `R2_PUBLIC_HOST` = `pub-00ea5347e7c44125bbf6d96839b774b7.r2.dev` (hostname only; `lib/storage/r2.ts` adds `https://` and the key path)
- `R2_BUCKET` = `zuzi-images`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY` — issued by Cloudflare; rotate when needed
- `R2_BACKUP_BUCKET` = `zuzi-backups`
- `R2_BACKUP_KEY`, `R2_BACKUP_SECRET` — separate credentials scoped to the backup bucket

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
