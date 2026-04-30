# Prompt-tuning lessons — pinned

Rules that came out of the Ambiance v1→v8 and Background v1→v5 iteration
rounds in Krea, validated against multiple Zuzi WIPs. Read this before
tuning any preset prompt. The full per-prompt iteration lineage lives in
the comment block above each `*_PROMPT_BODY` constant in
`lib/gemini/imagePrompts.ts`; this file extracts the cross-cutting rules.

## 1. Pro defaults to "rendered AI-style" outputs for any "make it beautiful" framing

If the prompt asks the model to make the image beautiful, finished, or
polished without anti-language, Pro renders toward its default look —
smooth gradients, photographic finish, generic illustration aesthetic.
That's the opposite of what we want for a fine artist whose value is her
painterly hand.

**Rule:** anti-language is required. Tell the model exactly what NOT to
do, in the same paragraph as what to do. Examples that landed:

  - "Do NOT introduce a rendered, smooth, photographic, or generically
    'beautiful' background."
  - "Do NOT use AI-illustration finish."

Don't trust positive framing alone ("paint in her style"). The model has
seen orders of magnitude more "beautiful illustration" data than Zuzi-
specific painterly data; absent explicit prohibition, the prior wins.

## 2. Pro handles narrow operations better than broad ones

Whenever a preset has more than one legitimate interpretation, **don't
list the options**. Pick the interpretation that lands more reliably and
write the prompt for that one operation only. Listing alternatives biases
the model toward whichever option appears most familiar in its training,
not the one Zuzi actually wants.

Example failure (Background v4): "the new background can be a different
setting OR an abstract field of color." Pro biased toward abstract because
abstract was a labelled choice; outputs lost the figurative grounding.

Example success (Background v3): "Pick a background environment she
would have chosen — something that fits the mood and subject of her
painting. If she's painted an interior figure, the new background might be
a different interior. If she's painted a still life, a different surface
or setting." Concrete examples narrow the operation; the model picks
within the implied range.

**Rule:** one operation per prompt, with concrete examples for the
implied range. Multiple legitimate interpretations means multiple
presets, not multiple options inside one preset.

## 3. Imitating the artist's judgment beats prescribing aesthetic outcomes

"Make it beautiful" produces Pro's idea of beautiful. "She would have
completed it like this" produces an imitation of Zuzi's idea of complete.
The latter consistently wins for voice-preservation work.

Examples that landed:

  - "completes the painting in a way that she would likely have
    completed it"
  - "Pick a background environment she would have chosen"
  - "the same painting after the artist made one focused atmospheric
    pass"

The framing forces the model into an imitation-of-judgment mode rather
than its default optimization-of-aesthetic mode. The output looks like
HER work because the prompt asked for HER judgment, not for "good art".

**Rule:** prefer judgment-imitation phrasing ("she would have...") over
outcome-prescription phrasing ("make it beautiful / polished /
atmospheric").

## 4. Redundant style anchoring is load-bearing for voice preservation

When the goal is voice-preservation (preserving brushwork, marks, hand,
style), saying "in her style" once is not enough. Saying it three times
in three different ways is what reliably keeps Pro from drifting.

Example from Ambiance v8:

  > "...everything you add must be painted in HER style, with HER kind of
  > marks. If she's working flat and painterly, your additions are flat
  > and painterly. If she's using thick gestural strokes, your additions
  > are thick gestural strokes. Match her hand exactly."

Three statements of the same constraint:
  1. "in HER style, with HER kind of marks" — direct.
  2. "if she's working flat and painterly, your additions are flat and
     painterly" — example.
  3. "Match her hand exactly" — terse restatement.

The earlier v7 had only the first; outputs occasionally drifted to a
generic painterly look that wasn't quite hers. Adding the example and
the restatement is what locked it.

**Rule:** for voice-preservation, redundant style anchors are load-
bearing. Don't deduplicate them in a tidying pass. The redundancy is
the feature.

## 5. Real-output evidence in Krea > prose elegance

The cleaner shorter version of a prompt often loses to the redundant
longer one in actual outputs. Tune by running real prompts against real
sources, comparing real outputs — not by reading prose and judging
elegance.

A prompt that reads like a clear, well-written paragraph may produce
worse outputs than a prompt that reads like a paranoid lawyer wrote it.
The model isn't judging your prose. It's matching your text against its
prior. Specific, redundant, anti-language-loaded prompts trigger
specific, narrow, on-voice outputs.

**Rule:** validate prompts by running them, not by reading them. Keep
the version that produces consistently good outputs across multiple
sources, even if it reads worse on the page. Pin the iteration lineage
in a comment so future maintainers know why the prompt looks the way it
looks.

## 6. Painterly surface alone isn't enough — the geometry must be hers from construction

Pro's default behavior when prompted with "paint in her style" is to construct
geometry using realistic-perspective training defaults and THEN apply painterly
surface as a texture overlay. The result has correct linear perspective, accurate
proportions, and clean architectural angles underneath painterly brushwork — which
reads as "AI illustration with a painterly filter," not as her actual hand.

To get her actual shape language, the prompt must explicitly forbid the construct-
then-texture pattern and require the geometry itself to come from her hand from
the start. The construction is hers. The geometry is hers. The surface treatment
follows.

Example fix from Background v4:

  > The shapes underneath must already be hers — wobbly, simplified, gestural —
  > before any surface treatment is applied. If you find yourself drawing a
  > "correct" window or "correct" piece of furniture, simplify it, distort it,
  > flatten it, redraw it with her hand's wobble. The geometry is hers. The
  > construction is hers. Not just the surface.

This lesson is distinct from #1 (anti-AI-illustration) and #4 (redundant style
anchoring). #1 forbids the wrong AESTHETIC; #4 demands repeated style anchoring at
the SURFACE level. #6 is about the CONSTRUCTION layer — even with anti-language
and redundant style anchors, Pro will draw the underlying shape with realistic
geometry unless the prompt also forbids that explicitly. This pattern likely
applies to other operations beyond Background where her style needs to drive
construction (the underlying shape language), not just surface treatment.

**Rule:** when an operation requires the artist's style to drive shape language,
the prompt must explicitly forbid the construct-then-texture pattern and anchor
the construction stage to her hand. Anti-perspective + anti-accurate-proportions
language belongs in the same paragraph as the her-shape-language demand.

## 7. Stylistic reference anchors will override the input's actual mood unless told not to

When a preset prompt names a stylistic reference for aesthetic anchoring (e.g.
"80s/90s cel animation", "Lillian Bassman photography", "Caravaggio
chiaroscuro"), Pro reaches for the reference's stereotypical mood AND applies
it to the output — overriding the input painting's actual emotional register.
Cartoon = bright/playful; Bassman = moody/dark; Caravaggio = dramatic
chiaroscuro. The output ends up looking like a generic "cartoon mood"
photograph, not like Zuzi's painting with cartoon-color richness.

The Color v2 → v3 iteration is the canonical example. v2 anchored on "1980s/90s
Saturday morning cartoons" stylistically and produced wholesale palette swaps
that drifted skin tones and shifted mood toward moody/dramatic when Pro reached
for the cartoon reference's stereotypical aesthetic. v3 fixes this with four
explicit moves:

  1. **Anchor on HER existing palette as the base.** "Refine and enrich, don't
     replace." The dominant colors of the input must remain the dominant colors
     of the output.
  2. **Hard rule: skin tones are IDENTICAL to input, exempt from any shift.**
     Skin is identity in figurative work (see corollary below).
  3. **Explicitly name her actual emotional register.** v3 says "this artist's
     work is PEACEFUL, GENTLE, and QUIETLY WARM" so Pro doesn't manufacture a
     different mood from the cartoon reference.
  4. **Frame the stylistic reference as undertone, not takeover.** v3 says "Add
     cartoon-color richness as an undertone that supports the existing mood,
     never as a takeover that changes it."

**Rule:** when adding stylistic reference anchors to a preset prompt, ALWAYS
also explicitly preserve the user's actual emotional register. Pro will reach
for the reference's stereotypical mood and override the input's actual mood
unless told not to. Anchor the reference, then explicitly disclaim its
stereotypical mood ("Not moody. Not dark. Not chiaroscuro.") and name the
input's actual mood instead.

### Corollary: skin tones are identity in figurative work

Any preset that affects color must explicitly exempt skin or risk shifting
facial identity. Faces, hands, exposed skin must look exactly as the artist
painted them — even small hue/value shifts read as the model "deciding" the
subject's complexion, which is identity-altering in a way no painter would
accept. Color v3's load-bearing line:

  > ABSOLUTE RULE on skin tones: skin colors stay IDENTICAL to the input. Do
  > not shift skin hue, do not change skin warmth or coolness, do not
  > redistribute skin values, do not darken skin. Faces, hands, exposed skin
  > must look exactly as she painted them. Skin is identity — never touch it.

This corollary likely applies to Lighting (when iterated) and any future
color-touching preset. Even a "preserve the lighting" preset can drift skin
under the guise of relighting; the exemption needs to be explicit.

## How to use this doc

When iterating a preset prompt:

  1. Run the current version against 3+ different real sources in Krea.
     Look for failure modes (drift, repaint, AI-illustration finish,
     missing the operation).
  2. Identify which lesson(s) above the failure violates. Most failures
     are #1 (no anti-language) or #4 (insufficient style anchoring).
  3. Edit the prompt to add the missing element. Don't dedup; add.
  4. Re-run against the same 3+ sources. Lock the version that
     consistently lands.
  5. Port to `imagePrompts.ts` with a comment block documenting:
     - Iteration lineage (vN — what failed, vN+1 — what fixed it)
     - Which lesson(s) from this doc the version honors
     - "DO NOT improve, shorten, or deduplicate" warning where redundancy
       is load-bearing
  6. Add the new baseline to `samples/day-0/` and update the README.

If a tuning round teaches a new lesson, add it here.
