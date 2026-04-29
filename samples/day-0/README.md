# Day-0 regression baselines

Reference outputs from `scripts/smoke.ts` against `samples/inputs/`. Each
sub-directory is one (input × prompt-config) pair. Files inside are the
generated tiles (`tile-01.jpg`, `tile-02.jpg`, ...). When tuning prompts
or model parameters, regenerate the relevant baseline so future eyeball
checks have a stable reference for "what good output looks like."

The smoke runner writes to a slug-derived directory by default (e.g.
`untitled_artwork_3/`). For non-default preset configurations we move the
output to a suffixed sibling directory (e.g. `untitled_artwork_3-ambiance/`)
so the canonical default-prompt baseline stays at the unsuffixed path.

## Inputs

| Input | Description |
|---|---|
| `samples/inputs/Untitled_Artwork 3.jpeg` | A 4:5 Zuzi-style figurative WIP — woman with bouquet, pink/blue palette, dotted background. Used for prompt-tuning regressions because it has both developed passages (the figure) and sparse passages (the streaky wall) that surface different prompt-failure modes. |

## Baselines

| Directory | Input | Model · Resolution · Count | Prompt | Notes |
|---|---|---|---|---|
| `untitled_artwork_3/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Freeform** (empty presets) — the validated v0 "make this beautiful" prompt: vary colors, preserve everything else | Canonical default-prompt baseline. Matches the smoke-validated default that Zuzi originally approved. |
| `untitled_artwork_3-ambiance/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Ambiance v8 (locked)** — see `lib/gemini/imagePrompts.ts AMBIANCE_PROMPT_BODY`. Style-continuation framing: "continue the painting in her voice; add elements in her style." | Validated by Jeff in Krea against multiple Zuzi WIPs before being ported. Outputs visibly add painterly content (small vase in negative space, more developed bouquet) in the source's flat-painterly style, while preserving palette and composition. |
| `untitled_artwork_3-background/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Background v3 (locked)** — see `lib/gemini/imagePrompts.ts BACKGROUND_PROMPT_BODY`. Different-setting-in-her-hand framing with anti-language against AI-illustration finish. | Validated by Jeff in Krea. Outputs replace the source's pink-streak/blue-dot background with a different interior setting (window + chair, curtains + plant, etc.), painted in the source's loose painterly hand — NOT a generic AI-rendered background. Foreground (figure, dress, bouquet) preserved; palette family preserved; lighting direction preserved. |

## Prompt version history

The Ambiance prompt went through 8 iterations before locking; the Background
prompt went through 5 (3 viable + 2 rejected). Per-prompt lineage and the
load-bearing-redundancy + anti-language + judgment-imitation lessons are
documented in the comment blocks above each `*_PROMPT_BODY` constant in
`lib/gemini/imagePrompts.ts`. The cross-cutting rules that came out of those
rounds live in **`docs/PROMPT_LESSONS.md`** — read that before iterating
any preset prompt.

**Do not deduplicate locked prompts.** The redundant style-anchoring language
is load-bearing.

## When to regenerate

- Prompt change in `lib/gemini/imagePrompts.ts` → regenerate the affected
  baseline so the committed reference matches what the current code
  produces.
- Model upgrade (Gemini 3.x → next) → regenerate all baselines, note the
  model version in this README.
- Pricing change in `lib/cost.ts` → no regen needed (cost is metadata,
  not output).

## Cost

Each baseline tile = `pricePerImage(tier, resolution)` per
`lib/cost.ts`. A 3-tile Pro 1K regen = ~$0.40. Smoke runs do NOT honor
the monthly cap (they bypass `/api/iterate`'s cap-check by calling the
worker directly), so don't loop them in a script without tracking
manually.
