# v2.0 Smoke Gate — Style Explore Mode

This directory holds the inputs for the v2.0 smoke gate
(`scripts/smoke-style.ts`). The gate runs ONE sketch against EVERY style
painting in `styles/` and writes per-pair JPEGs + a `directives.json`
manifest to `samples/v2-day-0/<sketch-slug>/`. **Run it BEFORE any
v2.1+ schema/UI work** — its only job is to confirm the locked
multi-image directive produces good outputs on the real Gemini Pro
pipeline.

## Layout

```
samples/v2-day-0-input/
├── README.md            (this file)
├── sketch.jpg           ← the one sketch image at the top level
└── styles/              ← one or more style reference paintings
    ├── sargent.jpg
    ├── sorolla.jpg
    └── wyeth.jpg
```

- **`sketch.jpg`** — one image at the top level. The gate auto-discovers
  any single image file (jpg/jpeg/png/webp/heic). If you have multiple
  sketches you want to test, run the gate once per sketch with
  `--sketch <path>`.
- **`styles/`** — a directory of style reference paintings. Drop as many
  as you want; the gate fires one Gemini call per style image, in
  alphabetical order. Same supported extensions as sketches.

Both directories are gitignored (see `.gitignore`) — these are your
local working files, not committed.

## Running the gate

```bash
# Defaults: --model pro --resolution 1k, auto-discover sketch + styles
npm run smoke-style

# Override anything via flags
npm run smoke-style -- \
  --sketch path/to/some-other-sketch.jpg \
  --styles path/to/some-other-styles-dir \
  --model pro \
  --resolution 1k
```

**Default model is `pro`** even though production-default for Explore
mode is Flash. The gate runs the ceiling first: if Pro outputs are bad,
Flash will be worse. Flip to `--model flash` to A/B if Pro looks good.

## Outputs

```
samples/v2-day-0/<sketch-slug>/
├── sargent.jpg
├── sorolla.jpg
├── wyeth.jpg
└── directives.json     ← per-pair manifest with timings + costs + the directive used
```

For each (sketch, style) pair:
- **Success**: writes `<style-slug>.jpg` (re-encoded at JPEG q90)
- **Failure**: writes `<style-slug>.error.txt` with the error message

The manifest at `directives.json` is the authoritative record of what
was run — directive text, aspect ratio, model id, per-pair cost + wall
time. Eyeball it alongside the JPEGs.

## The locked directive

```
keep the character design exactly as is from image one but show a
completed work in the completed style of image 2. keep the exact
character style and shape.
```

Plus an appended `Match the input aspect ratio exactly (W:H).` sentence
per AGENTS.md §3 (output aspect == input aspect; the sketch's snapped
aspect drives the call).

**Do not edit the directive** without re-running this gate against
multiple sketches AND a fresh approval from Zuzi. The wording was
Krea-validated for character work; changes risk regressing quality on
the very thing the gate is meant to verify.

## When the gate passes

After the JPEGs are written, Jeff eyeballs them (or shows them to
Zuzi). If quality matches what he got hand-rolled in Krea, we proceed
to v2.1 (schema + library). If not, debug the pipeline (input ordering?
sharp config? Gemini model version drift?) BEFORE designing any UI.

The gate touches NO schema, NO UI, NO production code paths. Re-running
it is cheap (~$0.13/pair on Pro 1K; a 9-style batch is ~$1.21 total).
