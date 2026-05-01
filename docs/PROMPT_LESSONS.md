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

**Rule:** when using a stylistic/cultural reference in a preset prompt,
always explicitly preserve the user's actual emotional register first, then
apply the reference. Pro will reach for the reference's stereotypical mood
(cartoon = bright/playful, animation backgrounds = moody/atmospheric,
Bassman = dark/dramatic) and override the input's actual mood unless told
not to. The pattern: name the user's mood explicitly (e.g., `PEACEFUL,
GENTLE, QUIETLY WARM`), forbid the wrong moods explicitly ("Not moody. Not
dark. Not chiaroscuro."), then frame the reference as enhancement-of-mood
not replacement-of-mood.

**Cross-prompt consistency:** both Color v4 and Background v5 use the SAME
canonical mood-anchor language — `PEACEFUL, GENTLE, and QUIETLY WARM` is a
single shared string across both bodies. Future presets that touch color or
atmosphere should reuse this exact string rather than reinventing the
phrase. The canary `includes("PEACEFUL, GENTLE, and QUIETLY WARM")` runs
against both bodies in `scripts/check-prompts.ts`.

### Corollary: skin tones are identity in figurative work

Skin tones must be explicitly exempted from any color-affecting operation.
Without the exemption, Pro will shift skin hue/warmth as part of palette
refinement and accidentally change facial identity — even small hue/value
shifts read as the model "deciding" the subject's complexion, which is
identity-altering in a way no painter would accept. The fix: an "ABSOLUTE
RULE" paragraph stating skin colors stay IDENTICAL to the input, separate
from the broader color-refinement instructions. Color v4's load-bearing
line (carried forward verbatim from v3 when the rule was first locked):

  > ABSOLUTE RULE on skin tones: skin colors stay IDENTICAL to the input. Do
  > not shift skin hue, do not change skin warmth or coolness, do not
  > redistribute skin values, do not darken skin. Faces, hands, exposed skin
  > must look exactly as she painted them. Skin is identity — never touch it.

This rule applies to Color, will apply to Lighting if/when iterated, and to
any future preset that touches color values. Even a "preserve the lighting"
preset can drift skin under the guise of relighting; the exemption needs to
be explicit.

## 8. Read-and-develop beats swap-and-replace for structural presets

Presets that touch structural elements of the input (composition, setting,
framing, layout) work better when framed as "read the artist's intent and
DEVELOP it" rather than "swap this element for a different one." The swap
framing makes Pro invent a replacement; the read-and-develop framing makes
Pro identify what the artist is doing and push it further.

The Background v4 → v5 iteration is the canonical example. v4 framed
Background as "swap setting in her style" — Pro often executed too
aggressively, losing the artist's existing compositional intent (motifs,
framing devices, rhythm) in favor of a generic "different setting in her
hand." v5 reframed Background as "read her intent, develop her intent" and
Pro now reads the source's interior framing + polka dot motif and develops
them rather than swapping for an unrelated pastoral outdoor scene.

The fix language pattern, from Background v5:

  > Read the source carefully first. What is the artist doing? Is this an
  > interior or an outdoor scene? What compositional ideas is she working
  > with — vertical framing elements, color fields, repeating motifs (like
  > polka dots, stripes, pattern), layered passages, window framing,
  > architectural rhythm? What spatial logic is she using? What is she
  > TRYING to achieve in the background?
  >
  > Your job is to identify her compositional intent and DEVELOP it — push
  > her existing ideas further, refine them, deepen them, make them more
  > resolved. Not to invent a different scene.

Three load-bearing moves come with this framing:

  1. **Open with diagnostic questions.** "Read the source carefully first.
     What is the artist doing?" forces Pro into observation mode before
     generation mode — the prompt becomes a critique-then-respond pattern
     instead of a pure generative one.
  2. **Preserve the artist's structural choices explicitly.** Setting type
     (indoor/outdoor), motifs, framing devices, compositional rhythm —
     name each as something to keep, not something to replace.
  3. **Frame the operation as DEVELOP, not REPLACE.** Vocabulary matters:
     "develop", "refine", "deepen", "resolve further" all push toward
     iteration on the existing ideas; "swap", "replace", "new",
     "different" all push toward invention of a substitute.

**Rule:** for any preset that affects structural elements of the input
(composition, setting, framing, layout), use the read-and-develop framing
instead of swap-and-replace. Open with diagnostic questions about the
artist's intent, name the structural choices to preserve, and use
develop/refine/deepen vocabulary throughout. This pattern likely applies
to any future preset that affects compositional structure — not just
Background.

## 9. Active painterly posture beats passive refinement framing

When a preset's operation is about pushing or improving (not preserving or
transforming), Pro needs an active painterly posture to channel — not just a
technical instruction. Structural correctness alone (anchored on her colors,
skin exempt, mood preserved) gives Pro permission to change colors but no
creative direction to push toward — the result is timid lateral shifts that
feel lifeless. The fix: anchor the model in an active artist's posture, name
the energy explicitly, and forbid the timid failure mode.

The Color v3 → v4 iteration is the canonical example. v3 was structurally
correct: anchored on HER existing palette ("refine and enrich, don't
replace"), exempted skin tones, preserved her peaceful/gentle/warm mood. The
guardrails worked — outputs no longer drifted skin or shifted mood toward
moody/dramatic — but Pro made TIMID LATERAL color shifts that felt lifeless.
The clothing went from a tentative pink to a slightly different tentative
pink. The blue background found a slightly different blue. No real artistic
intent. v4 keeps every v3 guardrail and adds an active posture layer.

The fix language pattern, from Color v4:

  > Imagine the artist sat back down at this painting an hour later, looked
  > at it with fresh eyes, and decided to push the color further with more
  > confidence and joy. She'd make bolder color choices. She'd find the
  > painterly relationships her first pass didn't fully reach. She'd lean
  > into the warmth and richness her work always wants.
  >
  > That's the operation: the same painting, after she pushed the color one
  > more pass with confidence and joy.

Three load-bearing moves come with this framing:

  1. **Anchor in an active artist's posture, not a technical instruction.**
     "Imagine the artist sat back down… and decided to push the color
     further" channels a state of mind. "Refine and enrich her palette" is
     just an instruction.
  2. **Name the energy explicitly with non-technical vocabulary.** v4 uses
     `with confidence and joy`, `Make the colors sing`, `confident pushed
     choices`, `fully alive in her warm peaceful register`. These words
     don't describe a technical operation — they describe a posture.
     Pro picks up on the posture and channels it.
  3. **Forbid the timid failure mode explicitly.** v4's Do-NOT clause
     `Do NOT make timid lateral color changes that lack real artistic
     intent — make confident pushed choices` calls out the exact v3
     regression by name. Without this, Pro's risk-aversion default (don't
     change too much, the user might not like big changes) wins.

The cartoon-era reference is also reframed: in v3 it was a palette source
("the color sensibility of 1980s and 1990s Saturday morning cartoons"); in
v4 it's an energy/confidence anchor ("The animation reference is for ENERGY
and CONFIDENCE in color choice — not for setting choice or rendering
style"). Same words, different load-bearing role.

**Rule:** for any preset where the operation is improvement-oriented
(push, develop, resolve, enliven, deepen) rather than preservation-oriented
(keep, exempt, hold) or transformation-oriented (swap, replace, recolor),
the prompt must channel an active painterly posture. Imagine the artist
returning to the work; name the energy in non-technical vocabulary; forbid
the timid lateral failure mode by name. This pattern likely applies to any
future preset where the goal is making the painting more alive within its
existing register.

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
