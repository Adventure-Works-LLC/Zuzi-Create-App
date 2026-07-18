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

**No exceptions in the current codebase.** A historical v3.0 exception
existed for Style Blend mode (used the first blend style painting's
aspect) but was removed in v3.4 when blend's interpretation was
corrected — blend inputs are now tiles generated FROM the current
source, so the source's snapped aspect is the natural output aspect
for every mode (prompt, style_explore, style_blend). The aspect
resolution lives inline in `lib/gemini/runIteration.ts` and reads
the source row directly. See §14 for the Style Blend contract.

## 4. "Make this beautiful" tool — and the session loop

This is a "make this beautiful" tool. The model is given the input painting and asked to
reimagine it. Same prompt is sent on every parallel call within an iteration, temperature
default (1.0), so each call produces a different result.

**The model picks the answers.** There is no planner, no directive set, no taxonomy of
color schemes, no allowed/forbidden vocabulary. The model's creative judgment IS the
feature.

### The input language: 4 checkboxes, no description field

The user input is **exclusively four preset checkboxes** — `Color`, `Ambiance`,
`Lighting`, `Background` — **mutually exclusive (pick at most one)**. There is **no
free-text prompt field**. This is a hard product invariant: a description field would
push the tool from "make this beautiful" toward "do what I say," which is the wrong
product. Anyone tempted to add a description input as "just one more knob" should
re-read this paragraph and the plan's reference docs first.

> **Mutually-exclusive UI.** The picker was originally multi-select 0..4. It became
> single-select after Zuzi found the multi-select model harder to reason about than
> the single-operation-per-generation framing the locked prompts already imply
> (Ambiance/Background/Color all have strong preserve-this-aspect language that
> contradicts other presets — see "Dominators vs composers" below). Selecting one
> preset hides the other three (150ms fade-out + translateY); the selected one shows
> a small `×` cancel affordance. No selection = freeform mode (`presets: []` →
> v0 "make this beautiful" prompt). The technical capability for multi-element
> arrays remains in `lib/gemini/imagePrompts.ts buildPrompt` for legacy data
> compatibility — see the dominator-routing note below — but the UI never produces
> them anymore. **Product simplification chose a cleaner mental model over the
> theoretical flexibility of preset combinations; the trade was deliberate.**

#### Preset table (canonical reference)

| Checkbox | What changes | What's preserved |
|---|---|---|
| **Color** | Develops her existing palette by pushing color choices with confidence and joy — bolder hues, richer saturations, more painterly complementary relationships, accent colors that sing. Channels 80s/90s cel-animation color confidence applied through her aesthetic register. Skin tones exempt. | Skin tones (identical), her peaceful/gentle/warm mood, brushwork, marks, line work, dry chalky restrained surface register, composition, framing, subject, level of finish, value structure, lighting direction, motifs (color of motifs may shift but motifs themselves preserved), her wonky gestural shape language |
| **Ambiance** | Continues the painting in her voice — extends her own brushwork, marks, level of finish into the canvas; adds elements (a small object, a mark in negative space, atmospheric depth) painted in HER style | Existing developed passages (don't repaint), composition, palette family, subject identity, brushwork voice |
| **Lighting** | Mood, shadows, light direction | Color palette, composition, brushwork, subject, background, level of finish |
| **Background** | Reads the artist's compositional intent (interior/outdoor, framing devices, motifs, rhythm, color fields) and develops it — pushes her existing ideas further, refines them, makes them more atmospherically resolved. Indoor stays indoor; outdoor stays outdoor; existing motifs are preserved and developed. | Setting type (indoor/outdoor), her compositional ideas (framing, motifs, rhythm, color fields), foreground figure and subject, foreground brushwork, palette family, lighting direction, peaceful/warm mood, her dry chalky restrained mark register, her wonky gestural shape language |
| **Avery** | Painter-reference preset. Reimagines surrounding painted treatment in Milton Avery's voice — flat color planes, simplified shape language, atmospheric earthy palette. Locked body is intentionally brief (one sentence + permission to use Avery color); Pro is given creative latitude with the reference instead of fenced in by anti-language. | Character / subjects exactly. Figure preserved. Other aspects (mood, surface register, composition) inherit from whatever the brief prompt body doesn't explicitly grant Pro permission to change. |
| **Etching** | Drawing-technique preset. Adds classical old-master shadow hatching (parallel hatching, cross-hatching, soft graphite shading) to the shadow areas only. References Leonardo / Michelangelo preparatory drawings + Daumier / Anders Zorn graphite work. Single locked paragraph with explicit DO/DON'T language because Pro's default reading of "shadow hatching" drifts into adding white highlights or re-rendering the whole drawing. | Lit areas (bare paper exactly as they are), every existing line, warm paper background, no color, no white highlights. Only the shadow side gets graphite darkness added. |

> **Composition is gone.** Composition (reframing/repositioning the subject) was tried,
> didn't match the user's actual workflow, and was removed. Ambiance (continuing the
> painting in her voice) is the operation she actually wants. **Don't add Composition
> back without explicit user request.**

> **Etching and Lighting joined the hidden set in v5.8** (Jeff's
> request): same treatment as Color/Ambiance below — bodies, dominator
> routing, canaries, and smoke flags all stay; only `VISIBLE_PRESETS`
> shrank. The picker now renders three cells: Cezanne (default),
> Avery, Background.

> **Cezanne (v1, v5.8) is the third painter-reference preset and the
> always-on default** — took the slot from Avery (lineage: background
> → avery → cezanne; every snap-back + context-shift reset in
> stores/canvas.ts and InputBar.tsx now lands on `["cezanne"]`).
> Same brief-body architecture as Avery: study-then-paint framing
> ("study paul cezanne's paintings and paint this painting as if
> cezanne was painting it"), preserve character + subjects, cezanne
> color welcome. Canary locks the lowercase opener
> `"study paul cezanne's paintings"`.

> **Color and Ambiance are hidden from the UI.** After many iteration cycles
> neither `COLOR_PROMPT_BODY` nor `AMBIANCE_PROMPT_BODY` found an operation Zuzi
> felt confident shipping with. Rather than delete the work, the InputBar's preset
> picker (`components/krea/InputBar.tsx`) renders a four-cell `VISIBLE_PRESETS`
> subset (avery, etching, lighting, background); Color and Ambiance are
> excluded. Everything else stays: both prompt bodies, the dominator-ladder
> routing in `lib/gemini/imagePrompts.ts buildPrompt`, both canaries in
> `scripts/check-prompts.ts` (still drift-protected), and `--presets color` /
> `--presets ambiance` in `scripts/smoke.ts` for dev iteration. The
> `AMBIANCE_DEBUG` log line in `runIteration.ts` also stays — it's useful for
> verifying which Ambiance prompt body is in production if/when the feature is
> revisited. Re-enable a hidden preset by adding it back to `VISIBLE_PRESETS`
> (and adjusting the grid columns to fit the new cell count).

> **Avery (v1) is the newest preset and the first painter-reference one.** Body
> is intentionally brief — one sentence locking the operation ("do this like a
> milton avery while preserving the character and subjects") plus permission to
> use Avery color. Different shape from the other locked bodies, which lean on
> multi-paragraph anti-language to constrain Pro into Zuzi's register. Avery
> instead trusts Pro to know who Milton Avery is and gives it creative latitude
> with that reference. The preserve list is correspondingly narrower (just
> "character and subjects"); composition, mood, surface register all inherit
> from whatever the brief body doesn't explicitly grant Pro permission to
> change. Build canary (`scripts/check-prompts.ts`) locks the lowercase
> `"do this like a milton avery"` prefix so any future re-cap or paraphrase
> fails the build.
>
> **Avery is also the always-on preset default** (replaces Background, which
> held the slot before Avery shipped). The canvas store initialises `presets`
> to `["avery"]`; `addSource` and `setCurrentSource`'s context-shift resets
> snap back to `["avery"]`; the picker's outside-click dismiss + the Generate-
> while-transitional snap-back both call `setPreset("avery")`. The
> mutually-exclusive UI invariant ("the user can never persistently land in a
> no-selection state") still holds — the snap-back target is just Avery
> instead of Background now.

> **Etching (v1) is the second painter/technique-reference preset.** Where
> Avery references a painter, Etching references a drawing technique:
> classical old-master shadow hatching (parallel + cross-hatching + soft
> graphite shading) in the manner of Leonardo / Michelangelo preparatory
> drawings + Daumier / Anders Zorn graphite work. Operation is one-sided —
> add darkness to the shadow side, do NOT touch lit areas, do NOT add white
> highlights, do NOT introduce color. The body is a single paragraph of
> explicit DO/DON'T language because Pro's default reading of "shadow
> hatching" drifts into adding white highlights or re-rendering the whole
> drawing — both of which break the preserve list. The DO-NOTs are
> load-bearing; don't soften them. Build canary
> (`scripts/check-prompts.ts`) locks the lowercase
> `"add classical old master shadow hatching"` prefix.

#### Dominators vs composers (legacy / safety-net under exclusive UI)

The four presets split into two architectural categories in `imagePrompts.ts`. Under
the current mutually-exclusive UI the routing is **legacy / safety-net code** — the
UI only ever sends single-element preset arrays, so the dominator ladder never has
multiple presets to disambiguate in production. It stays in place for two reasons:
(a) legacy iterations in DB from before the UI exclusivity change may have multi-
element `presets` JSON, and rendering a stable prompt for those rows matters for the
History Drawer; (b) `scripts/smoke.ts` still accepts arbitrary `--presets` flags for
development testing of the prompt builder — the UI invariant lives in the UI layer,
not the prompt builder.

  - **Dominators**: have a dedicated multi-paragraph prompt body. When a dominator is
    checked, its body short-circuits the builder and any other checked presets are
    subsumed. This is intentional — dominator prompts include strong preserve-this-
    aspect language ("palette family stays identical", "lighting direction stays
    identical", etc.) that contradicts a "vary X" composer. If Zuzi wants compound
    edits, she runs two passes (e.g. Background to develop the existing setting →
    favorite a result → Color on the favorite to recolor). This was the v1 product
    intent and remains true under exclusive UI — two passes is now the *only* way to
    get a compound edit.
      - **Ambiance v8** — `AMBIANCE_PROMPT_BODY` (locked, Krea-validated).
      - **Background v5** — `BACKGROUND_PROMPT_BODY` (locked, Krea-validated).
        READ-AND-DEVELOP framing: Pro is asked to identify the artist's
        compositional intent first (interior/outdoor, framing devices,
        motifs, rhythm) and develop it rather than replace the setting.
        Hard rules: indoor stays indoor, outdoor stays outdoor; motifs
        (polka dots, pattern, repeating shapes) are preserved and
        developed, never removed. Mood register anchored on the canonical
        "PEACEFUL, GENTLE, and QUIETLY WARM" language shared with Color
        v4. Lesson #6 (construct-not-just-surface) and lesson #8 (read-
        and-develop beats swap-and-replace) both apply.
      - **Color v4** — `COLOR_PROMPT_BODY` (locked, Krea-validated). Develops
        her existing palette by PUSHING color choices with confidence and joy
        — bolder hues, richer saturations, accent colors that sing. The
        cartoon-era reference is framed as an energy/confidence anchor (not a
        palette-source). Same Zuzi-essence guardrails as v3 (canonical mood,
        skin exemption, dry chalky register, motif preservation) but with an
        active painterly posture ("imagine the artist sat back down…")
        replacing v3's passive refinement framing — v3 produced timid lateral
        shifts; v4 produces confident pushed choices. Lesson #7 (mood-anchor
        + skin-identity), lesson #8 (read-and-develop), and lesson #9
        (active painterly posture beats passive refinement) all apply.
  - **Composers**: would participate in the templated "Reimagine X, preserve Y"
    path. Today only Lighting falls here, and only when checked alone — every
    combination involving Lighting + a dominator routes to the dominator. When
    Lighting is iterated in Krea, it'll get the same locked-body + dominator
    treatment, at which point the templated path will have no callers and the
    builder collapses to a 4-way switch.
      - **Lighting** (templated, solo only).

Resolution order in `buildPrompt`:
  1. `presets: []` (empty) → freeform v0 "make this beautiful".
  2. `presets` includes `ambiance` → `AMBIANCE_PROMPT_BODY`.
  3. `presets` includes `background` → `BACKGROUND_PROMPT_BODY`.
  4. `presets` includes `color` → `COLOR_PROMPT_BODY`.
  5. otherwise → templated path (only `['lighting']` reaches here).

If multiple dominators are checked, the first hit in the ladder wins. Order is
deliberate: Ambiance is the broadest (voice continuation), Background is setting-
replacement, Color is palette-replacement. So Ambiance > Background > Color in
priority, which means e.g. `[color, ambiance]` runs the Ambiance prompt; the user
who wants both runs two passes.

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
  2. Runs 16 canary substring checks against the locked prompt bodies —
     opening sentences and load-bearing anchors:
       - v0 freeform: `"Reimagine it with new colors"`
       - Ambiance v8: opens `"Continue this painting in the same style…"`
         and contains `"HER style"`
       - Background v5: opens `"This painting needs its background developed
         and improved"` + read-source anchor `"Read the source carefully
         first"` + indoor/outdoor invariant `"Indoor stays indoor. Outdoor
         stays outdoor."` + motif-preservation anchor `"preserve those
         motifs as part of the composition"` + canonical mood anchor
         `"PEACEFUL, GENTLE, and QUIETLY WARM"` (shared with Color v4)
       - Color v4: opens `"This painting's colors should be developed and
         pushed…"` + active-posture anchor `"with confidence and joy"` +
         active-push anchor `"Make the colors sing"` + anti-timid anchor
         `"make confident pushed choices"` + canonical mood anchor
         `"PEACEFUL, GENTLE, and QUIETLY WARM"` (same byte string as
         Background v5) + skin-identity anchor `"Skin is identity —
         never touch it"`
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

## 13. Style Explore mode (v2)

The second creative-direction surface in Studio. Where prompt mode is
"I know what I want, push it on this painting" (preset-driven), Style
Explore is "I don't know what I want yet — show me my sketch
re-rendered in the style of each painting from my reference library."
Discovery surface → refinement handoff. Plan source-of-truth:
`/Users/jeff/.claude/plans/i-want-to-make-cheerful-orbit.md` §"Style
Explore Mode — v2 SPEC (canonical)".

### Schema delta (migration 0006)

  - **`style_paintings` table** — Zuzi's reference library (Sargent,
    Sorolla, Wyeth…). Semantically distinct from `sources` (her own
    work). Same shape as sources + optional `title` / `artist` / `note`
    / `tag` metadata + soft-archive column. `artist` became load-bearing
    in v4.0: the StylesPanel renders artist filter chips (All / per-
    artist / Untagged), long-press → "Set artist…" edits it (PATCH), and
    multi-file uploads batch-tag via one window.prompt per batch (POST
    accepts an optional `artist` form field). `tag` remains scaffolded
    and unused. v5.5 added a second intake path: the panel's "From
    link" button POSTs JSON `{importUrl, artist?}` and the server
    resolves the link (direct image, or any page's og:image —
    Pinterest pin pages upgrade to the /originals/ pinimg variant)
    via `lib/importImage.ts` (https-only + private-host guards), then
    runs the same normalize+insert tail as file uploads. Built for
    the iPad flow where download-then-upload is a dead end.
  - **`iterations.mode`** — `'prompt'` (default; backfills all v1 rows)
    | `'style_explore'`. Discriminates the worker branch. The text
    column has a NOT NULL DEFAULT 'prompt' so the migration is
    instantaneous and pre-v2 reads keep behaving identically.
  - **`iterations.parent_tile_id`** — re-added per AGENTS.md §6
    cleanup-then-revive (was dropped in v1 as dead weight; v2 makes it
    load-bearing for "Iterate on this direction" provenance). Set on
    prompt-mode iterations spawned from a style_explore tile via the
    lightbox handoff.
  - **`tiles.style_painting_id`** — populated per-tile in
    style_explore iterations AND on every tile of prompt-mode
    iterations spawned from the handoff (the route copies the single
    handoff stylePaintingId onto every tile). NULL for organic
    prompt-mode tiles.

**Weak FK enforcement caveat.** Both new FK columns
(`iterations.parent_tile_id`, `tiles.style_painting_id`) were added
via `ALTER TABLE ADD COLUMN`. SQLite does NOT enforce ON DELETE
actions on FKs added that way — drizzle-kit drops the clause from the
generated SQL for exactly that reason. The intended semantics are
**ON DELETE SET NULL** for both: hard-deleting a tile preserves the
spawned iteration (provenance link nulls); hard-deleting a style
painting preserves the referenced tiles + R2 outputs (attribution link
nulls). These are enforced manually via the `nullifyParentTileForTileIds`
/ `nullifyParentTileForIteration` / `nullifyParentTileForSource` /
`nullifyTilesForStylePainting` helpers in `lib/db/queries.ts`, called
from inside every hard-delete transaction (tile, iteration, source,
style painting, empty-iteration sweep). Same pattern as the existing
`nullifyUsageLogForSource` / `*ForIteration` helpers for the equally-
weak `usage_log.iteration_id` FK. **If you add a new hard-delete code
path that removes tiles, you must also nullify any parent_tile_id
references** — or the FK's default NO ACTION will block the delete.

### The locked directive

```
keep the character design exactly as is from image one but show a
completed work in the completed style of image 2. keep the exact
character style and shape.
```

> **v5.6 "Her colors" switch.** The ExploreSheet's idle footer has a
> per-session toggle (default OFF). ON runs a SECOND locked directive
> per engine family — `STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE`
> (imagePrompts.ts, Gemini) / `FAL_STYLE_EXPLORE_KEEP_COLORS_DIRECTIVE`
> (engineConstants.ts, Max+Seedream) — which keeps the SKETCH's palette
> and takes only texture/brushwork/surface from the reference. Persisted
> per-iteration as `iterations.keep_source_colors` (migration 0011) so
> recovery replays fire identically; captioned "style explore · her
> colors" in the stream; "More like this" inherits the seed row's
> state. OFF remains the original directive above, byte-untouched (and
> the closed prompt-tuning verdict in the session memory applies to
> the OFF directive — the ON variant is a distinct user-requested
> operation, not a re-tuning). All four directives canary-locked.
>
> **v5.7 "Loose" switch (wording revised v5.8.1).** Second global pill
> beside "Her colors" (both moved to the InputBar next to Match/Flip
> in v5.6.2; state in the canvas store, read at fire time by
> card-taps, sheet batches, and "More like this"). v1 loose was purely
> subtractive and let the REFERENCE's shape grammar walk in (Jeff:
> "it uses their shape style and it sucks"). v2 pins the vocabulary:
> the reference contributes the PAINTED TREATMENT only; the line-and-
> shape language stays image one's, and the model's liberties happen
> INSIDE that language ("feel free to change and play with the drawing
> within image one's line and shape language"). The fal loose variants
> RETAIN the anti-borrow sentence (theft protection — the documented
> failure mode where the reference's subject replaces hers). A
> "line and shape" anchor canary guards all four loose variants. The two switches compose into a
> 4-way directive select per engine family
> (`buildStyleExplorePrompt(aspect, keepSourceColors, loose)` /
> the FAL_*_LOOSE_* constants); `iterations.loose` (migration 0012)
> persists it; captions append "· loose". Eight locked directives
> total, all canary-guarded, including negative canaries asserting the
> loose variants contain NO character-preservation wording.

Lives in `lib/gemini/imagePrompts.ts` as `STYLE_EXPLORE_DIRECTIVE`.
Byte-locked from Jeff's Krea validation against character work
(confirmed Zuzi's practice is figurative). If her practice ever
expands to landscape / still life / abstracts, this template needs a
generalised variant — flag and re-run the v2.0 smoke gate
(`scripts/smoke-style.ts`) before changing it. The directive's
"image one / image two" wording is load-bearing — the API call's parts
array order is FIXED: sketch first (image one), style painting second
(image two), then directive text.

Build canary in `scripts/check-prompts.ts` locks the opener phrase
"keep the character design exactly as is from image one" + asserts
`buildPrompt({mode:'style_explore'})` ignores `presets` entirely
(returns bytes identical to `buildStyleExplorePrompt`). The smoke gate
re-imports `STYLE_EXPLORE_DIRECTIVE` from `imagePrompts.ts` so the
bytes that pass the gate are byte-identical to what production serves.

### Mode contract — invariants

  1. **style_explore bypasses the preset dominator ladder entirely.**
     The route accepts a `presets` field in style_explore mode (for
     payload consistency) but the worker ignores it — `buildPrompt`
     short-circuits to `buildStyleExplorePrompt(aspectRatio)` on the
     mode='style_explore' branch. Variation across tiles comes from
     swapping image two (the style painting), not from text.

  2. **stylePaintingIds (array, style_explore) vs. stylePaintingId
     (single, prompt-mode handoff) are mutually exclusive at the API
     layer.** The route rejects mixing them with cross-field validation:
     stylePaintingIds in prompt mode → 400; single stylePaintingId in
     style_explore mode → 400. Each mode owns one and only one of the
     two fields.

  3. **Aspect ratio is the SKETCH's** (per §3) regardless of mode. The
     style painting is a reference input whose own aspect is
     irrelevant to the output dimensions. `iter.aspect_ratio_mode`
     (match/flip) modulates the sketch's aspect; the style painting
     is never the basis for `imageConfig.aspectRatio`.

  4. **The "Iterate on this direction" handoff is a prompt-mode
     iteration with both a parent_tile_id AND a per-tile
     style_painting_id.** The worker detects the prompt-mode-with-
     style-tile case (`promptModeHasStyleRef`) and:
       - Prefetches the style painting bytes (deduped across tiles —
         the handoff puts the SAME stylePaintingId on every tile, so
         it's one R2 GET regardless of tile count).
       - Includes the style as second image input on every Gemini call.
       - Tells `buildPrompt` to set `withStyleReference: true` which
         prepends "The second image is a style reference — channel its
         painted treatment, brushwork, and palette sensibility while
         preserving the first image's composition, subject, and
         identity." to the resolved preset body.
     The result: the new iteration's tiles render Zuzi's sketch in the
     same direction as the seed style_explore tile, but with the
     preset (typically Avery) applied on top.

  5. **The session loop persists across the sheet.** ExploreSheet
     fires iterations into the canvas store's `iterations[]` — the
     same array the regular Studio TileStream reads from — so closing
     the sheet leaves the explored tiles visible in the main stream
     under their iteration row (with the `mode: 'style_explore'` field
     surfaced so the IterationRow header can render a distinguishing
     chip in a future iteration of the UI). Refresh, switch sources,
     come back → the row is still there because it's stored normally.

### Cost protection

ExploreSheet defaults to **Flash** (the InputBar default is Pro). Per
the plan, discovery is cost-sensitive — many style tries per session
makes the cheap tier the right default. The sheet's tier toggle is
local (doesn't bleed into the InputBar), passed via
`generate({modelTier: 'flash', ...})` which threads it as a per-call
override. The InputBar's Pro default stays Pro.

Stop button halts BETWEEN batches, not mid-batch. In-flight Gemini
calls have already been charged the moment the worker fires the
`generateContent` request — cancelling client-side throws money away.
Worst-case cost floor on Stop = remaining-tiles-of-current-batch ×
`pricePerImage(tier, resolution)`. The Keep-going mode's
IntersectionObserver also gates on `userStopped` so no further
triplets fire after Stop.

MONTHLY_USD_CAP (default $250 since July 2026 — the original $80 was
hit by real usage four days into a month; override via Railway env
var, keep the two route constants in lockstep) gates every iteration.
POST /api/iterate
returns 429 monthly_cap_reached with `{currentUsd, capUsd}` when the
projected iteration cost would push month-so-far past the cap; the
sheet parses this from generate()'s thrown error message into a
sticky red banner and auto-fires Stop.

### Critical files

  - `lib/gemini/imagePrompts.ts` — `STYLE_EXPLORE_DIRECTIVE` constant,
    `buildStyleExplorePrompt(aspectRatio)`, `buildPrompt` accepts
    `mode` + `withStyleReference`.
  - `lib/gemini/runIteration.ts` — mode branch + multi-image parts
    construction + style-bytes prefetch.
  - `app/api/iterate/route.ts` — request body grows mode +
    stylePaintingIds + stylePaintingId + parentTileId with cross-field
    validation.
  - `app/api/iterations/route.ts` + `app/api/favorites/route.ts` —
    responses grow iteration.mode + iteration.parentTileId + per-tile
    stylePaintingId.
  - `components/krea/ExploreSheet.tsx` — 3-state machine (idle →
    running → done), Keep-going IntersectionObserver, Stop button,
    cap banner.
  - `components/krea/StyleAttributionThumb.tsx` — per-tile attribution
    chip under every tile carrying a style_painting_id (in both
    ExploreSheet grid and the main IterationRow).
  - `components/krea/Lightbox.tsx` — Compare-target swap + "Iterate
    on this direction" / "More like this" pair when
    `view.stylePaintingId` is set. Since v5.1 the pair renders
    ALONGSIDE "Use as source" (which is unconditional on every done
    tile) — it used to replace it, which made favorited style tiles
    dead-ends for Zuzi's pick-a-keeper→new-source flow.
  - `lib/db/queries.ts` — `insertStylePainting`, `listStylePaintings`,
    `getStylePainting`, `hardDeleteStylePainting`,
    `nullifyTilesForStylePainting` + the parent_tile_id nullify
    helpers.
  - `scripts/check-prompts.ts` — 4 new canaries (locked opener,
    constant-equality, aspect-ratio sentence, mode='style_explore'
    bytes-equality with buildStyleExplorePrompt).
  - `scripts/smoke-style.ts` — the v2.0 standalone gate; re-imports
    `STYLE_EXPLORE_DIRECTIVE` so smoke bytes equal production bytes.

## 14. Style Blend mode (v3.4 — current; supersedes v3.0)

Third creative-direction surface in Studio. Where prompt mode is preset-
driven and Style Explore (§13) is sketch + ONE style per tile, Style
Blend takes **N (2..MAX_BLEND_TILES) of Zuzi's already-generated
TILES** and fuses them into a new painting that combines their best
aspects. **Cross-source since v4.4** — inputs may come from ANY
sketch's iterations (she switches sources mid-selection to collect
tiles from different bases); the blend lands on whichever source is
current at fire time, and that source anchors the iteration + drives
the output aspect per §3. (v3.4–v4.3 enforced a same-source rule;
removed at Jeff's request when Zuzi wanted to mix bases.)

> **Important historical note.** v3.0 shipped this feature with the
> WRONG interpretation: it blended STYLE LIBRARY REFERENCES (Sargent
> + Sorolla source paintings → fused-source image). Zuzi tested it +
> called it useless. v3.4 reworked end-to-end: blend inputs are the
> TILES she generated from running Style Explore on her sketch (each
> already a "her sketch in some style" output). Migration 0008
> dropped the v3.0 column + added the new one. If you read v3.0
> commit messages, that's what they describe; the live code matches
> §14 here.

Plan source-of-truth: `/Users/jeff/.claude/plans/i-want-to-make-cheerful-orbit.md`.

### Schema delta (v3.0 migration 0007 → v3.4 migration 0008)

- **`iterations.mode`** still grows `'style_blend'` from 0007 — that
  enum value carries forward to v3.4 unchanged.
- **`iterations.blend_tile_ids`** (v3.4) — TEXT JSON array of tile
  ids. Stored on the iteration (not per-tile) because every tile in
  a blend run uses the SAME N input tiles; variation across output
  tiles comes from Pro's temp 1.0 stochasticity. `tiles.style_painting_id`
  stays NULL for blend tiles. No FK enforcement (JSON column);
  existence + same-source rule + 'done'/output_image_key validity all
  checked at the route. The worker hard-fails if any blend input
  tile is missing/un-fetchable at run time.
- **`iterations.blend_style_ids`** (v3.0) — DROPPED in 0008. Held
  style_painting_ids which was the wrong shape; data was wiped
  deliberately (semantically incorrect). SQLite 3.35+ DROP COLUMN
  used (better-sqlite3 12.x bundles ≥ 3.45).

### The locked directive

```
Make a new painting using the best aspects of these reference paintings,
maintaining their styles and intent.
```

Lives in `lib/gemini/imagePrompts.ts` as `STYLE_BLEND_DIRECTIVE`. The
wording is verbatim from Jeff's feature request — intentionally
trusts Pro's judgment of "best combination" without the elaborate
constraint language Color v4 / Background v5 use. Note: the directive
text says "reference paintings" — that still works for v3.4 because
the inputs ARE completed paintings (her sketch already rendered);
no prompt change needed for the v3.4 reinterpretation. If outputs
drift toward generic / averaged / collaged results in production,
the next iteration can add anti-language per the lesson-#1 pattern.

Build canary in `scripts/check-prompts.ts` locks the opener phrase
"Make a new painting using the best aspects" + asserts the constant
appears in `buildStyleBlendPrompt`'s output + asserts the unified
`buildPrompt({mode:'style_blend',...})` returns the same bytes
(defense-in-depth against any future "unified entry" refactor).

### Mode contract — invariants

1. **No sketch input in `parts[]`.** The Gemini call's parts array is
   `[tile1Bytes, tile2Bytes, ..., tileNBytes, text]` — N TILE
   OUTPUTS (R2 keys `outputs/<iter>/<idx>.jpg`) in user-selection
   order, then the directive. The worker skips the source bytes
   fetch entirely for blend iterations. The iteration row still
   anchors to `source_id` for cascade + history, AND the source's
   aspect drives the output aspect (no exception to §3 — the v3.0
   "first blend style's aspect" exception is gone).
2. **Cross-source selection (v4.4; supersedes the v3.4 same-source
   rule).** Blend inputs may come from any source's iterations. The
   contract pieces:
     - The store PRESERVES `blendMode` + `blendSelectedTileIds` across
       source switches and source archives (both cleared them pre-v4.4).
       Selected tiles in non-visible streams keep their ids; rings
       reappear when she switches back.
     - Hard-deleting the CURRENT source scrubs its tile ids from the
       selection (`removeSource` collects them from the in-store
       iterations). Hard-deleting a NON-current source can leave stale
       ids the client can't scrub (its iterations were never loaded) —
       the route's existence check rejects those at fire time with a
       clean 404 `blend_tile_not_found` (documented defense-in-depth).
     - The route validates existence + active + 'done' only. The 400
       `blend_tile_cross_source` rejection was removed in v4.4.
     - BlendActionBar's empty-stream auto-exit gates on an EMPTY
       selection too — switching to a source with no runs mid-
       collection must not wipe her picks.
3. **Inputs must be 'done' tiles with output_image_key.** Route
   rejects with 400 `blend_tile_not_ready` if any input is still
   pending/blocked/failed. Defense-in-depth against UI race; the
   tile selector gates this client-side too.
4. **Per-iteration attribution, not per-tile.** `tiles.style_painting_id`
   is always NULL for blend tiles. The N tile ids live on
   `iterations.blend_tile_ids`. IterationRow renders a
   "Blend of [thumb][thumb][thumb]" row above the tile grid via
   `BlendTileAttributionRow` + `BlendInputTileThumb` (looking up
   the input tiles' thumb keys from the current source's iterations[];
   v4.4 cross-source inputs miss that lookup and fall back to a
   module-cached GET `/api/tiles/:id` — one fetch per unknown id per
   tab session. Deleted inputs 404 and render the "?" placeholder).
5. **Lightbox hides Compare for blend OUTPUT tiles.** A blend output
   doesn't have a single source-input relationship — Compare-with-
   source would render a misleading before/after pair. Use-as-source
   still works (a blend tile can become a new sketch). "Iterate on
   this direction" + "More like this" hide because the output tile's
   `stylePaintingId` is null.
6. **Hard-fail iteration if any input tile is missing/un-fetchable
   at worker time.** Different from style_explore's per-tile graceful
   skip — blend with a missing reference is meaningless. The worker
   calls `hardFailIteration` which sweeps every pending tile row to
   `'failed'` with the same error message, so the UI never shows
   iteration=failed + tiles=pending.
7. **Cross-field validation at the route.** `mode='style_blend'`
   REQUIRES `blendTileIds: string[]` length [2, MAX_BLEND_TILES],
   no duplicates. REJECTS `stylePaintingIds`, `stylePaintingId`,
   `parentTileId`. Existence check order: idempotency → source →
   cap → blendTileIds existence + 'done' + same-source → insert.
8. **Tile component blend-mode UX.** When `canvas.blendMode === true`,
   tap on a 'done' non-optimistic tile toggles selection (instead of
   opening the Lightbox). Selected tiles get a thick brass ring + a
   numbered badge in the top-right (1, 2, 3...). The action row
   (favorite + ... menu) HIDES in blend mode to prevent destructive
   actions mid-selection. Numbered badge is the documented exception
   to the "no overlay on painting surface" rule — it's a deliberate
   response to user action, small (28px), and dismisses on tap.
9. **BlendActionBar height ResizeObserver.** The floating action bar
   publishes its height to `--blendbar-h` on the document root so
   TileStream's bottom padding clears it (otherwise the last
   iteration row gets clipped by the bar's ~60-80px overlay).
   Mirrors InputBar's `--inputbar-h` pattern.

### Cost

`MAX_BLEND_TILES = 4` (defined in `lib/gemini/imagePrompts.ts`). Cap
chosen because Pro's reasoning over N>4 reference inputs is
unexplored + likely muddy. Per-tile cost = `pricePerImage(tier, '1k')`;
default `TILE_COUNT_DEFAULT = 3` tiles per blend submission.
Multi-image input may carry additional Gemini token cost not
currently modeled in `lib/cost.ts` — re-verify against pricing docs
if production usage feels expensive.

### Critical files

- `lib/gemini/imagePrompts.ts` — `STYLE_BLEND_DIRECTIVE`,
  `buildStyleBlendPrompt(aspectRatio)`, `MAX_BLEND_TILES`,
  `buildPrompt` early-return on mode='style_blend'.
- `lib/gemini/runIteration.ts` — mode branch, blend-tile bytes
  prefetch (getTile + tile.output_image_key, NOT getStylePainting),
  full-recovery skip-guard, `hardFailIteration` sweep on missing
  input tile. Aspect = source.aspect_ratio (under §3 invariant; no
  exception).
- `lib/db/queries.ts` — `failPendingTilesForIteration` helper for
  the hard-fail sweep + `FavoriteRow.mode` field for the Lightbox's
  cross-source iterationMode lookup.
- `lib/gemini/presets.ts` — `parseBlendTileIdsJson` shared parser
  with corruption-warning logs (context-arg-gated).
- `app/api/iterate/route.ts` — request body grows `blendTileIds` +
  `parseBlendTileIds` validator (reject duplicates, length
  [2, MAX_BLEND_TILES], all ids must be active 'done' tiles — any
  source since v4.4) + cross-field validation matrix + idempotent
  replay echo on both branches + ordering: idempotency → source →
  cap → existence → insert.
- `app/api/iterations/route.ts` + `app/api/favorites/route.ts` —
  responses grow `iteration.blendTileIds` and `favorite.iterationMode`.
- `stores/canvas.ts` — `blendMode` + `blendSelectedTileIds` slots.
  v4.4: selection PERSISTS across source switch + source archive
  (cross-source collection is the feature); still auto-scrubbed on
  iteration delete / tile delete / current-source hard delete. A
  stale id from a non-current source's hard delete is caught by the
  route's 404 at fire time.
- `components/krea/SourceStrip.tsx` — Blend toggle button (Layers
  icon, pressed-state styling).
- `components/krea/Tile.tsx` — blend-mode tap-to-select; selection
  ring + numbered badge; action row HIDDEN in blend mode.
- `components/krea/BlendActionBar.tsx` — floating bottom bar (z-30)
  with selection count + cost preview + Blend N tiles + Cancel.
  Publishes height to `--blendbar-h` via ResizeObserver. Auto-exits
  blend mode when iterations[] is empty.
- `components/krea/IterationRow.tsx` — `BlendTileAttributionRow` +
  `BlendInputTileThumb` subcomponents using `useShallow`-stable
  `[id, thumbKey][]` projection + `useMemo` Map (avoids re-render on
  every store mutation).
- `components/krea/Lightbox.tsx` — Compare hides for blend tiles via
  `view.iterationMode === 'style_blend'` short-circuit (compareKey
  resolves to null).
- `scripts/check-prompts.ts` — 4 canaries for the locked directive
  (opener, constant-equality, aspect sentence, mode equivalence).

## 15. When changing this file

  - If you're adding a new architectural contract: add a numbered section
    at the bottom. Keep each section focused on one durable rule.
  - If you're updating an existing section: keep the cross-references intact
    (search for `§N` and `docs/...md` and verify the linked content still
    matches).
  - The file lives behind `CLAUDE.md` (which is `@AGENTS.md`). Updating
    AGENTS.md updates what every Claude session in this repo sees as
    project instructions. Treat changes here as load-bearing.

## 16. Sketch Vary mode (v5) — the fal FLUX LoRA engine

Fourth creative-direction surface, and the FIRST that does not call
Gemini. Where prompt mode pushes a painting with presets, Style Explore
re-renders a sketch per style reference, and Style Blend fuses tile
outputs, **Vary redraws the CURRENT SOURCE in Zuzi's own hand**: the
sketch goes through img2img on FLUX.1-dev + a style LoRA trained on her
own drawings.

### The product operation (hard-won — do not regress)

> "take what's there and ONLY what is there and move it around a bit to
> adjust the look of the current one to try and perfect what she did"

Settle/perfect the drawing. **No added iconography, EVER** — suns, rain,
flowers, extra limbs, new objects all killed this feature in 22 rounds
of Gemini prompt testing (July 2026; ~$16, ~100 generations, hit the
documented ~60–75% per-draw ceiling for holding a naive style via
prompting). The LoRA won the A/B decisively: every first-draw output in
her hand. That history lives in the session memory + the board; the
takeaway is architectural: **her style lives in the WEIGHTS, not the
prompt.** Don't try to re-achieve Vary with Gemini prompting.

### Engine assets

  - **LoRA**: trigger word `ZUZQ`, trained on fal.ai
    (`fal-ai/flux-lora-fast-training`, `is_style: true`, 1000 steps, 10
    curated originals). Weights: `ZUZQ_LORA_URL` env var (fal CDN;
    unguessable URL — treat as a secret, never commit) + a local copy at
    `data/zuzq-lora-v1.safetensors` (gitignored). Retraining ≈ $2.
  - **Dataset law** (for any retrain): her app sources are CONTAMINATED —
    many are Gemini generations she re-uploaded. Train ONLY on verified
    originals (Jeff identifies). Dedupe near-identical revision states to
    one image. More originals sharpen per-sheet formulation fidelity
    (known nit: eye formulation occasionally borrows from a different
    sheet of hers).
  - **Inference**: `fal-ai/flux-lora/image-to-image`, 32 steps, LoRA
    scale 1.0, input resized to ≤1344px long edge, sent as a data URI
    (nothing persisted to fal storage). One call per tile, N parallel.

### The locked prompt + strength dial

`VARY_PROMPT` lives in `lib/fal/varyConstants.ts` (dependency-free so
client components can import; `lib/fal/vary.ts` re-exports for the
worker). Byte-locked from the winning lab run; build canaries in
`scripts/check-prompts.ts` lock the `"ZUZQ style rough sketch."` opener,
the `"keep every element exactly where it is"` anchor, and the
`"Add nothing new."` anchor.

Variation size is the **strength dial, not prompt changes**:
`VARY_STRENGTHS = [0.45, 0.6, 0.75]` (closed set, route-validated,
canary-locked): 0.45 subtle = "perfect what she did"; 0.60 medium =
liberties inside her vocabulary; 0.75 wild = free-range her world. If
Vary outputs feel wrong, tune strength or retrain the LoRA — the prompt
is not the knob.

### Mode contract — invariants

  1. **mode='sketch_vary' forces `model_tier='flux'`,
     `resolution='1k'`, `aspect_ratio_mode='match'`** at the route,
     regardless of body. The §4 Gemini cost table does not apply;
     pricing is `costForVary` in `lib/cost.ts` (~$0.035/image,
     resolution-independent). The monthly cap check covers vary.
  2. **§3 aspect invariant holds via the engine itself.** img2img
     output inherits the (resized) input's dimensions — there is no
     `imageConfig.aspectRatio` equivalent and no aspect sentence in the
     prompt. The three Gemini-specific steps of §3 are N/A; the
     INVARIANT (output aspect == source aspect) still holds for every
     vary tile.
  3. **`vary_strength` is persisted on the iteration** (migration 0009)
     because boot-time recovery replays re-read the row and must fire
     the identical call. Route validates the closed set; the worker
     hard-fails the iteration on an invalid persisted value.
  4. **Vary tiles are ordinary tiles.** Same R2 key scheme
     (`outputs/<iter>/<idx>.jpg` + thumbs), same recovery.jsonl rows,
     same SSE events, same favorites — every downstream surface is
     engine-agnostic. Lightbox: Compare STAYS (source vs varied is the
     honest before/after); "Use as source" STAYS and is the Sketch-Lab
     handoff (pick a variation → it becomes a new source → Generate
     with presets). "Keep the original" = just don't switch.
  5. **Cross-field validation**: `varyStrength` rejected outside vary
     mode; `stylePaintingIds` / `stylePaintingId` / `blendTileIds` /
     `parentTileId` all rejected inside it. Presets accepted-but-
     ignored (client sends `[]`), same defensive posture as
     style_explore.
  6. **Deployment fail-fast**: POST /api/iterate returns 503
     `vary_not_configured` when `FAL_KEY` or `ZUZQ_LORA_URL` is unset —
     checked AFTER idempotency (replays still echo) and before any
     further DB work. Both env vars must be set on Railway (sealed
     vars) AND in local `.env`.
  7. **fal call hygiene**: 180s wall-clock guard per call (a stuck
     queue must not hold tiles pending until the next boot sweep);
     retry is 1+1 (a timed-out call may still complete and charge — the
     accepted cost floor, same doctrine as §13's Stop button). The fal
     safety-checker flag maps to tile status 'blocked' via the
     classifyError 'safety' path.

### Critical files

  - `lib/fal/varyConstants.ts` — VARY_PROMPT + VARY_STRENGTHS +
    varyStrengthLabel (client-safe, zero imports).
  - `lib/fal/vary.ts` — lazy fal client (§9 hygiene), generateVaryImage,
    varyConfigMissing; re-exports the constants.
  - `lib/gemini/runIteration.ts` — sketch_vary branch + runOneVaryTile;
    shared persistTileOutput / tryRecoveryHydrate / markTileError
    helpers keep the two engines byte-identical downstream.
  - `app/api/iterate/route.ts` — mode + varyStrength validation,
    config fail-fast, forced column values, replay echo.
  - `lib/cost.ts` — costForVary / varyPricePerImage (the only pricing).
  - `components/krea/InputBar.tsx` — Vary button + 3-strength popover.
  - `components/krea/IterationRow.tsx` — "vary · subtle" caption +
    "her lora" tier label.
  - `scripts/check-prompts.ts` — 5 vary canaries.
  - `scripts/smoke-vary.ts` — provider gate (real fal call, ~$0.04).

## 17. Alternate engines in the tier pill (v5.4) — Max + Seedream

The InputBar's model pill grew from `Flash | Pro` to
`Flash | Pro | Max | Seedream`. Flash/Pro are Gemini; **Max**
(`fal-ai/flux-2-max/edit`) and **Seedream**
(`fal-ai/bytedance/seedream/v5/lite/edit`) run on fal. Outcome of the
July 2026 model lab, run on Zuzi's own favorited (sketch, style)
pairs against every serious contender (FLUX.2 pro/max, Seedream
4.5/5-Lite, Qwen ±LoRA, Grok, GPT-Image-2, NB 2 Lite):

  - **Nano Pro stays the champion + default** — best character
    preservation with committed style transfer.
  - **Max**: same price as Pro (~$0.13), strongest painterly surfaces,
    occasionally softens her faces toward realism. Quota-immune.
  - **Seedream**: ~4× cheaper ($0.035 flat), character-safe,
    80–90% of Pro's commitment. Quota-immune.
  - Everything else was eliminated (drift/bleed) — don't re-add
    without a new lab pass. Seedream 5 **Full** is the watch-item;
    when fal serves a non-Lite v5 edit endpoint, rerun the bake-off.

### Contract

  1. **Explicit choice, never a fallback.** The user picks the engine
     in the pill; every IterationRow is captioned with its engine
     ("flux max 1k", "seedream 1k"). Do NOT auto-route to these on
     Gemini quota errors — a silent hand-swap violates the no-silent-
     drift doctrine. (The quota-failure caption *suggests* switching;
     the tap is hers.)
  2. **model_tier values**: `flux2max` | `seedream` join
     flash/pro/flux. 'flux' remains vary-only (mode-forced, never in
     the pill). All five flow into usage_log.model_tier; only 'pro'
     counts toward the daily gauge.
  3. **Prompts per engine family**: style_explore on fal engines runs
     the locked `FAL_STYLE_EXPLORE_DIRECTIVE`
     (lib/fal/engineConstants.ts — the BFL role-per-image + anti-bleed
     template each engine was validated with; canary-guarded). Preset
     bodies and the blend directive pass through unchanged — trying
     Avery-on-Max is a deliberate user experiment, engine-labeled.
  4. **§3 aspect invariant** holds via explicit pixels: both endpoints
     accept `image_size: {width, height}` (schema-verified; max
     14142/side). `falImageSize(aspectRatio, resolution)` maps '1k' →
     1440 long edge, '4k' → 2560 (Max bills per output MP — a true
     4096 edge would double its price silently).
  5. **Env**: FAL_KEY only (shared with Vary). Route 503s
     `engine_not_configured` when missing — checked after idempotency,
     like vary's.
  6. **Pricing** lives in lib/cost.ts PRICE_PER_IMAGE_USD with
     provenance comments; monthly cap covers all tiers.

### Critical files

  - `lib/fal/engineConstants.ts` — tiers, labels, locked fal explore
    directive (client-safe).
  - `lib/fal/engines.ts` — endpoints, falImageSize, provider call
    (retry ×2, 180s guard, safety flag → 'blocked').
  - `lib/gemini/runIteration.ts` — falEngineTier branch +
    runOneFalEngineTile.
  - `app/api/iterate/route.ts` — tier validation + engine 503.
  - `components/krea/InputBar.tsx` — 4-option pill.
  - `scripts/check-prompts.ts` — 2 fal-directive canaries.
<!-- END:zuzi-studio-guardrails -->
