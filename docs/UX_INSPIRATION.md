# UX inspiration — pinned

We are building a single-screen creative tool for one working artist. The interaction
is: input bar fixed to the bottom (camera / library / drag-drop / paste / file picker),
four preset checkboxes immediately below it (Color / Ambiance / Lighting /
Background, multi-select 0–4), Flash|Pro and 1K|4K toggles, Submit. Above the input,
a vertically scrolling stream of generated tiles, newest at top, earlier tiles
pushed down as new ones land. Each Submit produces N tiles (default 3) that slide in
together. Tap a tile for the lightbox; star to favorite. The aesthetic is gallery /
studio, not SaaS — quiet, calm, no engagement loops, no upsells, no notifications.

This document pins the references we are drawing from, what we copy, and what we
deliberately reject.

## Reference: Krea (krea.ai)

**Krea** (`krea.ai`) is the canonical reference for the interaction pattern Zuzi
Studio is adopting — input bar pinned at the bottom of the viewport, generated
visuals streaming in above as the user scrolls. Multi-modal (image, video, 3D),
multi-model, with the composer always visible and previous prompts still in
place.

The rest of this doc describes the **input-at-bottom + tiles-stack-up pattern**
as practiced by krea.ai, with cross-references to ChatGPT image generation and
Midjourney's web UI where they sharpen specific decisions. The documented
patterns are the patterns we are adopting; the timing numbers and animation
specs that aren't tied to a directly-observable product are flagged in the
"Open questions" section.

## Interaction model (faithful to the pattern)

### Input bar (bottom)

The dominant pattern: a single composer pinned to the bottom of the viewport,
full-width, with a primary input plus inline secondary actions for attachment, model
selection, and submit. ChatGPT, Krea, and Midjourney web all converge here.
Cloudscape's pattern reference: "frequently performed actions like file upload should
be displayed as secondary actions in the prompt input." Camera / library / file-picker
lives **inside** the input bar, not above it.

Height expands with content (single line → multi-line up to a cap). Settings (model,
resolution) are presented as **segmented controls or pill toggles inline with the
input row**, not dropdowns that hide state. Visible-by-default beats
hidden-and-rediscoverable for a tool used every day.

### Tile stream (above input)

Classic chat UIs (ChatGPT) put newest at the bottom, immediately above the input —
chat convention. Creative-feed products diverge: newest at top, new tiles push
earlier ones down. Zuzi's tool is a creative feed, not a chat thread, so
newest-at-top is correct. Earlier tiles should not jump or reflow beyond the natural
push-down.

### Tile arrival animation

No citable spec for any specific app's slide-in duration. What I could verify:

- **ChatGPT 4o** uses a top-down progressive reveal — "each row of pixels loading from
  the top down, like dial-up." Per-image render, not per-tile arrival.
- **Skeleton/shimmer** loaders run **700ms–2s** on a loop while pending; NN/G
  recommends slow-and-steady motion that doesn't draw attention to itself.
- **Framer Motion** patterns: `opacity` (0→1), `y` translate (8–16px), optional
  `filter: blur()` (4px→0) over 250–400ms ease-out.

**Recommended for Zuzi:** placeholder tiles appear instantly on Submit so the user
sees the count of N=3. Each placeholder pulses softly (1.6–2s, opacity 0.6→1.0). On
completion each tile cross-fades from placeholder to image with 8px upward translate
and 4px blur release over **300ms ease-out**. Stagger within a batch by 60–80ms so
they don't all flash at once.

### Tile interactions

- **Tap** → lightbox.
- **Long-press** → contextual action (favorite, save, copy prompt). On iPad Safari
  long-press also triggers the system "Save Image" menu, so the app gesture must not
  conflict — typically the corner star is the primary path and long-press is a
  shortcut.
- **Corner heart/star** as a visible affordance — preferred for a calm tool (no
  hidden gesture to discover). Favorites are load-bearing per AGENTS.md §4.
- **Lightbox**: swipe between, pinch-zoom, tap-to-dismiss. Two-up side-by-side is a
  shipped requirement.

### Lightbox / detail view

Quiet, full-bleed, dark surround, minimal chrome. Toolbar holds: favorite toggle,
share (Web Share API for iOS native share sheet, per AGENTS.md), close. No social CTAs,
no "make variations" upsell, no related-images carousel.

### Empty state

For an artist-oriented tool the empty state should not be a marketing hero, a sample
gallery, or a "try this prompt" carousel. It should be the input bar at the bottom of
an otherwise empty canvas, with a brief one-line cue ("Add a painting to begin" or
similar) above it. The point is that the next step is obvious and there is nothing
else competing for attention.

### Preset / parameter UI

Category mix: Pixlr / VEED / Canva use preset chips (pill rows) for color / lighting
/ composition / style. Midjourney V8 exposes parameter flags as UI controls. DeepAI
uses sliders. The four-checkbox approach (Color / Ambiance / Lighting /
Background, multi-select 0–4) is simpler than any of these — correct for a
single-purpose tool. Use square checkboxes with labels, not pills — pills look like
filter tags, and these aren't filters, they're directives. Checked state should be
unambiguous (filled square + check + label weight shift), not a subtle tint.

(Composition was tried as the second checkbox, didn't match the user's actual
workflow, and was replaced with Ambiance. See AGENTS.md §4 for the rationale.)

## Other reference apps

- **Krea** — closest behavioral reference. Bottom-pinned prompt, conversational
  stream, multi-model. Worth opening on iPad to study live.
- **Midjourney web (V8)** — Imagine bar with inline mood-board, references,
  personalization. Default 4-up grid per prompt. Borrow: settings live in the
  composer, not in a modal.
- **ChatGPT image generation** — dial-up-style top-down render. Calming on a single
  image but would feel laggy across N=3 in parallel. We want all-at-once-with-stagger.
- **Krea Realtime** — sketch-driven instant generation on iPad. Not our pattern
  (submit-then-wait, not real-time) but the touch-first iPad ergonomics are the
  gold-standard reference.
- **Cara** (`cara.app`) — explicitly anti-AI artist platform. Useful as a check on
  what working artists object to in AI tools.

## Pinned decisions for Zuzi Studio (different from Krea / others)

- **Quiet, gallery-feel, no engagement loops.** No streaks, daily prompts, "your
  image is ready" notifications, share-to-social CTAs, or upsell modals. Tool, not
  feed.
- **No human gate.** Per AGENTS.md §4: borderline outputs are a prompt bug, not a
  re-roll opportunity. The UI never asks "approve this batch?" — it just shows tiles.
- **Four preset checkboxes**, not a chip rack and not a settings drawer. Color /
  Ambiance / Lighting / Background, multi-select 0–4. Visible by default. Square
  checkboxes, not pills.
- **Default 3 tiles per Submit** (configurable). Lower than Midjourney's 4 because
  Zuzi runs many parallel sources and the Flash/Pro × 1K/4K knobs already give her
  tier control.
- **Tile arrival**: instant placeholders → 1.6–2s soft pulse → cross-fade + 8px
  translate + 4px blur release, 300ms ease-out, 60–80ms intra-batch stagger. Newest
  at top.
- **Visible favorite affordance** (corner star) plus long-press shortcut.
- **Vocabulary**: prefer art-tool verbs. "Generate" works for the button.
  "Reimagine" fits the refresh-on-same-source action. Avoid "conjure" (twee),
  "create" (overused), "iterate" (engineering jargon). Loading caption: "Painting…"
  or nothing — the pulse is the indicator, text is noise.
- **Empty state**: input bar at bottom of empty canvas, one-line cue. No hero, no
  examples, no onboarding tour.

## Open questions / things to verify

1. **Is "Craya" actually Krea, or a different product?** Could not verify any
   public Craya product. Screenshot or App Store link would ground future decisions.
2. **Krea tile arrival timing** — needs first-hand recording on iPad. The 300ms
   / ease-out / 60–80ms stagger recommendation is from category convention, not
   Krea-specific telemetry.
3. **Pending-state visual** in Krea — shimmer? pulse? something else? Needs
   first-hand observation.
4. **iPad portrait keyboard behavior** — when the soft keyboard is up, does the
   bottom input float above it, or does the stream compress? Known pain point in
   bottom-pinned-input designs.
5. **Multi-tile batch layout** — does Krea present N images side-by-side in one
   row (Midjourney-style 2×2) or stacked vertically? Our default-3 fits either;
   choice affects iPad portrait vs landscape tile width.

## Sources

- [Krea: AI Creative Suite for Images, Video, & 3D](https://www.krea.ai/)
- [Krea](https://canvas.krea.ai/chat)
- [Krea — Product Hunt](https://www.producthunt.com/posts/krea-chat-2)
- [Krea AI Ultimate Guide 2026 — AI Tools DevPro](https://aitoolsdevpro.com/ai-tools/krea-ai-guide/)
- [Introducing 4o Image Generation — OpenAI](https://openai.com/index/introducing-4o-image-generation/)
- [ChatGPT's New Image Generation Feels Like Dial-Up — How-To Geek](https://www.howtogeek.com/chatgpts-new-image-generation-feels-like-dial-up-all-over-again/)
- [Midjourney 2026: v8 Specs, Web Interface — AI Tools DevPro](https://aitoolsdevpro.com/ai-tools/midjourney-guide/)
- [Where should AI sit in your UI? — UX Collective](https://uxdesign.cc/where-should-ai-sit-in-your-ui-1710a258390e)
- [Generative AI chat — Cloudscape Design System](https://cloudscape.design/patterns/genai/generative-AI-chat/)
- [Skeleton Screens 101 — NN/G](https://www.nngroup.com/articles/skeleton-screens/)
- [React Animation — Motion.dev](https://motion.dev/docs/react-animation)
- [Pixlr AI Image Generator](https://pixlr.com/image-generator/)
- [VEED AI Image Variation Generator](https://www.veed.io/tools/ai-image-editor/ai-image-variation-generator)
- [Cara — anti-AI art app](https://drawingwithpri.art/blogs/blog/ai-art-app)
- [Reve Image](https://app.reve.com/)
- [Craiyon](https://www.craiyon.com/en)
