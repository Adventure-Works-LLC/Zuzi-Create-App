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
| `untitled_artwork_3-background/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Background v4 (locked)** — see `lib/gemini/imagePrompts.ts BACKGROUND_PROMPT_BODY`. Stay-in-her-universe framing + 80s/90s painted-animation atmospheric reference for mood depth + explicit shape-language anchoring (geometry must come from her hand from the construction stage; anti-perspective, anti-texture-overlay). | Canonical Background baseline, replaces v3. Validated by Jeff in Krea. Outputs replace the source's pink-streak/blue-dot background with a deeper-mood interior setting that stays in her universe (same kind of place — domestic interior); the new architectural / furniture shapes are wobbly + simplified + gestural rather than perspective-correct, and the painterly surface treatment matches her hand. Foreground (figure, dress, bouquet) preserved; palette family preserved; lighting direction preserved. |
| `untitled_artwork_3-background-v3/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Background v3 (archived, prior lock)** — different-setting-in-her-hand framing with anti-language against AI-illustration finish, but no shape-language anchoring. | Historical reference. Compare against v4 to see what the shape-language anchoring (lesson #6) bought us: v3 outputs sometimes drew perspective-correct windows / furniture and applied painterly surface as a texture overlay — visible "AI illustration with painterly filter" feel — which v4 fixes by demanding the geometry itself come from her hand. |
| `untitled_artwork_3-color/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Color v3 (locked)** — see `lib/gemini/imagePrompts.ts COLOR_PROMPT_BODY`. Refines her existing palette toward 80s/90s cel-animation color richness (saturation bump, complementary play, painterly depth) — but anchors on HER colors as the base, exempts skin tones from any shift, and explicitly preserves her peaceful/gentle/warm mood register. | Canonical Color baseline, replaces v2. Validated by Jeff in Krea. The dominant colors of the input remain dominant in each output; skin tones are byte-stable across all three tiles; mood stays in her peaceful/airy register rather than drifting toward the cartoon reference's stereotypical brightness or moodiness. Three variants explore different complementary pushes within her existing palette family. |
| `untitled_artwork_3-color-v2/` | Untitled_Artwork 3 | Pro · 1K · 3 | **Color v2 (archived, prior lock)** — wholesale palette replacement framing ("Recolor it using the palette sensibility of 1980s and 1990s Saturday morning cartoons"). | Historical reference. Compare against v3 to see what the mood-register + skin-identity anchors (lesson #7) bought us: v2 outputs swapped the palette wholesale, drifted skin tones (faces lost identity), and shifted mood toward moody/dramatic when Pro reached for the cartoon reference's stereotypical aesthetic. v3 anchors on her existing palette as the base and explicitly names her actual peaceful/warm mood. |

## Prompt version history

The Ambiance prompt went through 8 iterations before locking; the Background
prompt is now at v4 (v1 templated → v2/v3 her-hand framing → v4 adds 80s/90s
animation atmospheric reference + explicit shape-language anchoring; v3 lives
on at `untitled_artwork_3-background-v3/` as a historical reference); the
Color prompt is now at v3 (v1 templated → v2 cel-animation lock did wholesale
palette replacement and drifted skin/mood → v3 anchors on HER existing palette
as the base, exempts skin tones from any shift, and explicitly preserves her
peaceful/warm mood register; v2 lives on at `untitled_artwork_3-color-v2/` as
a historical reference). Per-prompt lineage and the load-bearing-redundancy +
anti-language + judgment-imitation + construct-not-just-surface + mood-
override + skin-identity lessons are documented in the comment blocks above
each `*_PROMPT_BODY` constant in `lib/gemini/imagePrompts.ts`. The cross-
cutting rules that came out of those rounds live in
**`docs/PROMPT_LESSONS.md`** — read that before iterating any preset prompt.

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
