/**
 * The shared image prompt builder for the "make this beautiful" tool.
 *
 * Used by `scripts/smoke.ts` and `lib/gemini/runIteration.ts`. The prompt is
 * derived from the per-iteration `presets` array (a subset of `PRESETS` from
 * `lib/db/schema.ts`). Same prompt is sent on every parallel call within an
 * iteration; temperature stays at default (1.0) so N parallel calls produce
 * N different results.
 *
 * Per-preset architecture (see also `docs/PROMPT_LESSONS.md` for cross-cutting
 * lessons):
 *
 *   **Dominators** — preset has a dedicated multi-paragraph body. When the
 *   preset is checked, its body short-circuits the builder and any other
 *   checked presets are subsumed. This is intentional: dominator prompts
 *   include strong preserve-this-aspect language that contradicts a "vary X"
 *   composer (e.g. Color v4 keeps lighting direction identical, which
 *   would clash with Lighting). If the user wants compound edits — e.g.
 *   refined colors AND new lighting — they run two passes: Color first,
 *   then Lighting on a favorited result.
 *     - Color v4 (locked) — see `COLOR_PROMPT_BODY`.
 *     - Ambiance v8 (locked) — see `AMBIANCE_PROMPT_BODY`.
 *     - Background v5 (locked) — see `BACKGROUND_PROMPT_BODY`.
 *
 *   **Composers** — would participate in the templated "Reimagine X,
 *   preserve Y" path. Today only Lighting falls here, and only when checked
 *   alone. When Jeff iterates Lighting in Krea it'll get the same locked-
 *   body + dominator treatment, at which point the templated path will
 *   have no callers and the builder collapses to a 4-way switch.
 *     - Lighting (templated, solo only — combinations with any of the
 *       three dominators get subsumed).
 *
 *   **Empty presets** — the validated freeform v0 "make this beautiful"
 *   prompt. Vary colors, preserve everything else. Bit-identical to what
 *   Zuzi approved in the original smoke runs.
 *
 * Resolution order in `buildPrompt`:
 *   1. presets is empty → freeform.
 *   2. presets includes 'ambiance' → AMBIANCE_PROMPT_BODY.
 *   3. presets includes 'background' → BACKGROUND_PROMPT_BODY.
 *   4. presets includes 'color' → COLOR_PROMPT_BODY.
 *   5. otherwise → templated path (only `['lighting']` reaches here).
 *
 * If multiple dominators are checked, the first hit in the ladder wins.
 * Order is deliberate: Ambiance is the broadest (voice continuation),
 * Background is setting-replacement, Color is palette-replacement.
 * Lighting is currently the only composer — it composes with itself, which
 * is to say it just renders solo via the templated path.
 *
 * `aspectRatio` is always stated explicitly inside the prompt AND passed via
 * `config.imageConfig.aspectRatio` on the API call (belt-and-suspenders).
 * See AGENTS.md §3 ("Output aspect ratio always equals input aspect ratio")
 * and §4 ("Make this beautiful" tool).
 */

import { PRESETS, type Preset } from "../db/schema";

/** Default tiles per Submit. Single source of truth — DB column default
 * (`iterations.tile_count`) and API route default both reference this value. */
export const TILE_COUNT_DEFAULT = 3;

/** Hard ceiling on tiles per Submit. The API route refuses requests above
 * this value; the UI never offers a control beyond it. Chosen as the prior
 * 3×3 grid count so a reflexive "give me 9" still works without inflating
 * cost surface. */
export const TILE_COUNT_MAX = 9;

/** Stable order in which presets appear in the rendered prompt. */
const PRESET_ORDER: ReadonlyArray<Preset> = PRESETS;

// ---------------------------------------------------------------------------
// COLOR — v4 locked.
// ---------------------------------------------------------------------------

/**
 * Color prompt body — **v4 (LOCKED)**. Validated by Jeff in Krea against the
 * bouquet portrait — Pro now makes bolder confident color choices instead of
 * timid lateral nudges, while staying in her warm peaceful register.
 *
 * Operation: develop and PUSH her existing palette with confidence and joy
 * — bolder hues, richer saturations, more painterly complementary
 * relationships, accent colors that sing. Channels 80s/90s cel-animation
 * color confidence applied through her aesthetic register. Skin tones
 * exempt. NOT timid lateral refinement (that was v3's failure mode).
 *
 * **The structural shift v3 → v4 is significant.** v3 framed Color as
 * "refine and enrich her palette" — structurally correct (anchored on
 * HER colors, skin exempt, peaceful mood preserved) but produced lifeless
 * lateral color shifts because Pro had permission to change colors
 * without any creative direction to push toward. v4 frames Color as
 * "imagine the artist returning to push the painting with confidence and
 * joy" — Pro now channels an active painterly posture rather than
 * executing a passive technical refinement.
 *
 * v4 follows the same READ-AND-DEVELOP pattern as Background v5 (read
 * intent, identify what she's doing, develop it further) but adds a
 * load-bearing layer: an ACTIVE PAINTERLY POSTURE the model channels
 * ("the artist on her second pass with confidence"). The posture-anchor
 * language ("with confidence and joy", "Make the colors sing",
 * "confident pushed choices") is what unlocked v4 after v3's
 * structural-but-lifeless results. See lesson #9 in
 * `docs/PROMPT_LESSONS.md`.
 *
 * Honors the cross-prompt rules pinned in `docs/PROMPT_LESSONS.md`:
 *   - Anti-language: "Do NOT use AI-illustration finish", "Do NOT make
 *     the colors look digital, printed, or vector", plus the new anti-
 *     timid clause "Do NOT make timid lateral color changes that lack
 *     real artistic intent".
 *   - Narrow operation: ONE era / sensibility (cel animation 80s/90s) +
 *     ONE mood register (her existing peaceful/gentle/warm) — both
 *     pinned, both load-bearing.
 *   - Judgment imitation: develop her palette as SHE would have pushed
 *     it on a second pass, not Pro's idea of "more colorful".
 *   - Lesson #7 (mood-override): the cartoon-era reference is named as
 *     stylistic anchor for ENERGY/CONFIDENCE only; the input's actual
 *     mood is named explicitly ("PEACEFUL, GENTLE, and QUIETLY WARM" —
 *     SAME canonical string as Background v5) so Pro doesn't reach for
 *     the reference's stereotypical mood.
 *   - Lesson #7 (skin-identity): skin tones are exempt from any shift —
 *     identity-bearing pixels in figurative work, never touched.
 *   - Lesson #8 (read-and-develop): open with diagnostic questions,
 *     preserve structural choices, develop within them.
 *   - **Lesson #9 (active painterly posture)** — new with this lock.
 *
 * **Architectural placement**: the preserve list explicitly includes
 * "lighting direction" and locks the mood register, which contradicts a
 * Lighting checkbox checked alongside Color. So Color is a **dominator**
 * (early-return regardless of other checked presets). Same routing
 * pattern as Ambiance v8 and Background v5. If Zuzi wants compound edits
 * (pushed colors AND new lighting), she runs two passes: Color first,
 * then Lighting on a favorited result.
 *
 * **Iteration lineage:**
 *   - v1 (frozen, original templated): "Reimagine the colors and palette
 *     as beautiful as possible, preserve everything else." Produced clean
 *     palette variations, validated by Zuzi but with no aesthetic
 *     direction (Pro picked nondeterministically per run).
 *   - v2 (locked, then superseded): first opinionated lock — "Recolor it
 *     using the palette sensibility of 1980s and 1990s Saturday morning
 *     cartoons." Wholesale palette replacement; drifted skin tones, lost
 *     peaceful mood when Pro reached for the cartoon reference's
 *     stereotypical aesthetic.
 *   - v3 (locked, then superseded): refined v2 — anchored on HER existing
 *     palette (refinement not replacement), exempts skin, preserves
 *     peaceful mood. Worked technically but Pro made TIMID LATERAL color
 *     shifts that felt lifeless — preservation framing gave permission
 *     to change colors but no creative direction to push toward.
 *     Production-served until v4.
 *   - **v4 (locked)**: structural reframe — Pro is told to imagine the
 *     artist returning to push the painting with confidence and joy.
 *     Same Zuzi-essence guardrails as v3 (canonical mood, skin exemption,
 *     dry chalky register, motif preservation) but with active painterly
 *     intent ("Make the colors sing", "confident pushed choices", "fully
 *     alive in her warm peaceful register"). The cartoon-era reference
 *     is now framed as an energy/confidence anchor, not a palette-source
 *     anchor. Anti-timid clause forbids the v3 failure mode explicitly.
 *     Validated in Krea by Jeff against the bouquet portrait.
 *
 * **Lesson:** active painterly posture beats passive refinement framing.
 * When a preset's operation is improvement-oriented (push, develop,
 * resolve, enliven), the prompt must channel an active artist's posture
 * — not just a technical instruction. See lesson #9 in
 * `docs/PROMPT_LESSONS.md`.
 *
 * Multi-paragraph body; aspect-ratio sentence appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const COLOR_PROMPT_BODY = `This painting's colors should be developed and pushed — not preserved, not just refined. Imagine the artist sat back down at this painting an hour later, looked at it with fresh eyes, and decided to push the color further with more confidence and joy. She'd make bolder color choices. She'd find the painterly relationships her first pass didn't fully reach. She'd lean into the warmth and richness her work always wants.

That's the operation: the same painting, after she pushed the color one more pass with confidence and joy.

Read the source carefully first. What is she doing with color? What palette family is she in? What relationships is she exploring? What's the emotional warmth she's reaching for? Then go further than she did. Make the colors sing.

Channel the color sensibility of 1980s and 1990s hand-animated cel animation — Disney's late-80s/90s renaissance, Don Bluth films, Saturday morning cartoons, 80s/90s Studio Ghibli — saturated but harmonious, painted color depth, complementary play, mood-rich palettes that serve storytelling and emotional warmth. Apply that confidence to her existing palette. The animation reference is for ENERGY and CONFIDENCE in color choice — not for setting choice or rendering style.

CRITICAL on mood: this artist's work is PEACEFUL, GENTLE, and QUIETLY WARM. Her paintings have a calm daydream quality — soft warmth, airy light, gentle cheerfulness, contemplative ease. The pushed color choices must amplify that peaceful warmth, not introduce a different emotional register. Bolder colors served by warmth. Richer hues served by gentleness. Pushed saturations served by calm. Not moody. Not dark. Not dramatic. Not chiaroscuro. The color development makes the painting MORE alive within her warm peaceful register, not less.

ABSOLUTE RULE on skin tones: skin colors stay IDENTICAL to the input. Do not shift skin hue, do not change skin warmth or coolness, do not redistribute skin values, do not darken skin. Faces, hands, exposed skin must look exactly as she painted them. Skin is identity — never touch it.

For everything else (clothing, hair, environment, background, accents, decorative motifs): take real creative license. Push hues toward more confident animation-era saturation. Find painterly complementary relationships her first pass didn't reach. Make accent colors sing instead of merely existing. Deepen the painted color depth. The clothing might go from a tentative pink to a confident, deeper pink. The blue background might find its more saturated daylight register. The polka dots might become more intentional in color. Make the choices a confident painter would make on her second pass with this work.

Render everything entirely in HER style. Her exact brushwork, her exact marks, her exact level of finish, her exact line work. Dry media — chalky pastel, charcoal, colored pencil — RESTRAINED. Surface dry, granular, chalky. NOT wet oil paint. NOT painterly blended brushwork. NOT cel-animation finish. NOT smooth digital rendering. The pushed color must come through her dry chalky mark register, not through any other surface treatment.

Her line work, marks, surface texture, motifs (polka dots, vertical strokes, decorative elements) all stay intact. Only color VALUES shift — but they shift with confidence and joy, not timidly.

Preserve EXACTLY: brushwork, mark-making, drawing style, composition, framing, subject, level of finish, value structure, lighting direction, peaceful warm mood, dry chalky restrained surface register, her wonky gestural shape language, her existing motifs.

Do NOT shift skin. Do NOT darken the painting overall. Do NOT shift mood toward moody, gloomy, melancholic, dramatic, cold, grey, or shadowed. Do NOT use AI-illustration finish or smooth her marks. Do NOT make the colors look digital, printed, or vector. Do NOT make timid lateral color changes that lack real artistic intent — make confident pushed choices. Do NOT abandon her motifs. Do NOT change subject or proportions.

The result should look like the same painting after the artist made one focused color pass with confidence and joy — bolder, richer, more painterly choices, fully alive in her warm peaceful register.`;

// ---------------------------------------------------------------------------
// AMBIANCE — v8 locked.
// ---------------------------------------------------------------------------

/**
 * Ambiance prompt body — **v8 (LOCKED)**. Validated by Jeff in Krea against
 * multiple Zuzi WIPs; produces consistently good outputs and outperforms the
 * cleaner v7 variants in real-world use.
 *
 * DO NOT improve, shorten, or deduplicate the redundant style-anchoring
 * language. The redundancy is **load-bearing** — it's what makes Pro stay in
 * Zuzi's voice instead of drifting to a generic "atmospheric overlay" mode.
 * The two lines that say "in HER style, with HER kind of marks" and the
 * concrete "if she's working flat / if she's using thick gestural strokes"
 * examples look redundant on paper; they're the difference between Pro
 * imitating her hand vs. inventing a new one.
 *
 * **Iteration lineage** (kept so future tuning has the prior context, and to
 * document the failure modes):
 *   - v1: drifted, repainted everything.
 *   - v2: too subtle — atmospheric whisper barely visible against developed
 *     passages.
 *   - v3: bold but crowded — added too much.
 *   - v4: quantity-capped ("add no more than two elements"); still busy.
 *   - v5: position-locked ("only in the upper-left quadrant"); lost magic.
 *   - v6: aesthetic-outcome framing ("make it feel finished"); Pro rendered
 *     toward a 3D-illustration finish quality, away from her painterly hand.
 *   - v7: style-continuation framing; removed finish-quality vocabulary.
 *     Cleaner prose, but Pro still occasionally drifted to its default look.
 *   - **v8 (locked)**: style-continuation + concrete style examples
 *     ("flat and painterly" vs. "thick gestural strokes") + redundant
 *     style anchors ("HER style, with HER kind of marks") + "she would
 *     have completed it" judgment-imitation framing. Validated in Krea by
 *     Jeff across multiple Zuzi WIPs.
 *
 * **Lesson for future preset tuning:** longer prompts with redundant style-
 * anchoring may outperform cleaner shorter ones, especially when the goal
 * is voice-preservation. Don't deduplicate aggressively. Real-output
 * evidence > prose elegance. See `docs/PROMPT_LESSONS.md` for the full
 * cross-prompt rule set.
 *
 * Multi-paragraph body; the aspect-ratio sentence is appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const AMBIANCE_PROMPT_BODY = `This painting is the artist's work-in-progress. She has been staring at it, sometimes for hours, trying to see the one move that would resolve it — the addition that would take it from almost-done to truly complete, from a painting to a masterpiece in her voice.

Your job is to find that move with her precision. Not to add something. Not to make the painting feel less empty. To identify, with painterly judgment, the SPECIFIC move that completes THIS specific painting and makes it unmistakably, fully Zuzi.

CRITICAL — work AT the painting level, never at the meta level: You are editing the painting itself by adding marks to its canvas. You are NOT photographing the painting. You are NOT framing the painting in a room or on a wall. You are NOT showing the painting being held or displayed. You are NOT adding masking tape, easels, studio context, walls, windows, floors, or any environment around the painting. The output must be the painting itself, edge-to-edge, exactly as it would appear if she added one more pass to the canvas. The frame of the output IS the frame of the painting. There is nothing outside it.

A Zuzi painting that's complete has these qualities — the figure carries quiet emotional weight, the composition has intentional restraint, every element in the painting feels purposeful, and the negative space breathes rather than feels empty. The completion move you find should bring the painting fully into that resolved state.

Before you make any move, you must be able to answer:

1. What specific compositional problem does this painting have right now? Where does the eye lose its way? What feels unresolved? What would Zuzi notice if she looked at this for another hour?

2. Why does this specific addition, in this specific location, solve that specific problem? What's the painterly logic? What's the compositional reasoning?

3. Why is this move unmistakably hers — something she would have eventually arrived at, in her hand, in her vocabulary?

If you cannot answer all three with confidence, the right move is to make NO change. Most paintings should come back unchanged or nearly unchanged. Only act when you've identified a genuine compositional problem AND a specific solution to it AND that solution is in her painterly vocabulary. The bar is high — make the move only when you can defend it.

When you do act, the move must be:
- COMPOSITIONALLY MOTIVATED: it solves a real visual problem in the painting (a weight imbalance, an unfinished passage, a disconnect between elements, an unresolved focal moment) — not added for atmospheric texture or decoration
- INTENTIONALLY PLACED: every aspect of the move's location, size, and form serves the compositional logic — not placed wherever there's empty space
- IN HER VOCABULARY: it uses the kind of element she actually paints — but ONLY her vocabulary, NEVER generic additions like decorative flowers, vases, picture frames, hearts, stars, butterflies, generic background objects, or any other stock decorative element. Her vocabulary is restrained and emotional: a quiet abstract mark, a subtle ambient passage, a gestural shape that supports the composition, a small accent that ties the painting together. Always emotionally and compositionally motivated, never decorative.
- INEVITABLE IN RETROSPECT: when you look at the finished painting, the addition should feel obvious, like the painting was incomplete without it and she finally saw the answer

Read the source carefully first. Spend real attention on:
- The figure's gesture and emotional weight — what mood is the figure carrying?
- The composition's structural logic — how do the elements relate? Is there compositional tension that wants resolution?
- The negative space — is the empty space functioning as breath, or is it functioning as absence? There's a difference.
- The existing motifs and elements — what visual language is she working in?
- What would resolve THIS painting specifically — not paintings in general, not "an unfinished work" in the abstract, but the unique compositional question THIS painting is asking?

Then make at most ONE move. Or none. Be Zuzi staring at her own work for hours and finally seeing it.

CRITICAL on what makes a Zuzi move:
- Her additions are ABSTRACT or GESTURAL — never representational decoration. A mark, a shape, a subtle color passage, a quiet gestural element. NOT a flower, NOT a vase, NOT a heart, NOT a recognizable object that wasn't already in her composition.
- Her additions emerge from emotional and compositional logic, not from a desire to fill space or decorate
- Her additions live in conversation with the figure — they relate to the subject emotionally or compositionally, they're never just background filler
- Her additions feel like they belong, not like they were added
- When in doubt, she leaves the painting alone

CRITICAL on mood: this artist's work is PEACEFUL, GENTLE, and QUIETLY WARM. Her paintings have a calm daydream quality — soft warmth, airy light, gentle cheerfulness, contemplative ease. The completion move serves and amplifies that mood. Not moody. Not dark. Not dramatic. Not gloomy. Not cute. Not decorative.

ABSOLUTE RULE on skin tones: skin colors stay IDENTICAL to the input. Do not shift skin hue, warmth, or coolness. Faces, hands, exposed skin must look exactly as she painted them. Skin is identity — never touch it.

CRITICAL on palette: don't change her colors. Any addition uses colors from her existing palette family — you are completing her painting in her color world, not introducing a new color story.

The painting must be rendered entirely in HER style. Her exact brushwork, her exact marks, her exact level of finish, her exact line work. Dry media — chalky pastel, charcoal, colored pencil — RESTRAINED. Surface dry, granular, chalky. Any new mark comes through her dry chalky register and must look like she painted it in this same session, with the same materials, in her hand.

Existing elements MUST stay in their EXACT positions. Do not move, relocate, or shift ANY existing element. The completion move is an addition or a refinement to negative space, never a rearrangement.

Preserve EXACTLY: the figure, subject, composition, framing, all existing painted elements and their exact positions, brushwork, mark-making, drawing style, color choices and palette family, skin tones, level of finish, value structure, lighting direction, peaceful warm mood, dry chalky restrained surface register, her wonky gestural shape language, her existing motifs.

Do NOT show the painting in a room, on a wall, with a frame, with masking tape, on an easel, held by anyone, or in any environmental context. Do NOT add decorative objects (flowers, vases, hearts, stars, butterflies, generic background props). Do NOT add elements without compositional justification. Do NOT add ambient texture or atmospheric marks for the sake of "feeling less empty." Do NOT make decorative additions. Do NOT place additions wherever there's empty space — placement must be intentional. Do NOT add multiple elements. Do NOT shift skin or palette. Do NOT change mood. Do NOT relocate existing elements. Do NOT use AI-illustration finish or smooth her marks. Do NOT abandon her negative space. Do NOT make a move you cannot defend with painterly reasoning.

The result should look like the same painting after the artist finally saw the one move she'd been searching for and made it with confidence — same composition, edge to edge as the canvas, same hand, same warm peaceful mood, with one inevitable, compositionally precise addition that makes the painting feel masterful and unmistakably hers. Or no change at all, if the painting was already complete.`;

// ---------------------------------------------------------------------------
// BACKGROUND — v5 locked.
// ---------------------------------------------------------------------------

/**
 * Background prompt body — **v5 (LOCKED)**. Validated by Jeff in Krea against
 * the bouquet portrait — Pro now reads the source's interior framing + polka
 * dot motif and develops them rather than swapping for a pastoral outdoor
 * scene.
 *
 * Operation: read the artist's compositional intent (interior/outdoor,
 * framing devices, motifs, rhythm, color fields) and DEVELOP it — push her
 * existing ideas further, refine them, deepen them, make them more
 * resolved. NOT replace the setting. Indoor stays indoor; outdoor stays
 * outdoor; existing motifs (polka dots, pattern, repeating shapes) are
 * preserved and developed, never removed. Mood anchored on the canonical
 * `PEACEFUL, GENTLE, and QUIETLY WARM` register matching Color v4.
 *
 * The structural shift v4 → v5 is significant: previous versions framed
 * Background as "swap setting in her style." v5 frames it as "read her
 * intent, develop her intent." This is the operation she actually wants
 * for background work — a thoughtful collaborator developing her
 * compositional ideas, not a replacement engine. See lesson #8.
 *
 * **Iteration lineage:**
 *   - v1 (templated, original): "as beautiful as possible" framing —
 *     drifted to rendered AI-style backgrounds, generic illustration finish.
 *   - v2 (Krea iteration): added style anchoring + her-hand language +
 *     "she would have chosen" judgment imitation.
 *   - v3 (locked, then superseded): refined v2 with concrete examples
 *     (interior figure → a different interior; still life → a different
 *     surface or setting). Production-served until v4.
 *   - v4 (locked, then superseded): added 80s/90s animation atmospheric
 *     reference + explicit shape-language anti-perspective anchoring (Pro
 *     was constructing perfect-perspective geometry with painterly surface
 *     overlay; v4 forced the geometry itself to be hers). Lesson #6
 *     (construct-not-just-surface) came out of this round. Production-
 *     served until v5. Still framed Background as "swap setting in her
 *     style," which Pro often executed too aggressively — losing the
 *     artist's existing compositional intent (motifs, framing devices,
 *     rhythm) in favor of a generic "different setting in her hand."
 *   - **v5 (locked)**: READ-AND-DEVELOP framing. Pro is asked to identify
 *     the artist's compositional intent first ("Read the source carefully
 *     first. What is the artist doing? What is she trying to achieve in
 *     the background?") and develop it rather than replace the setting.
 *     Hard rules: indoor stays indoor, outdoor stays outdoor; motifs are
 *     preserved and developed, not removed. Mood register anchored on the
 *     canonical `PEACEFUL, GENTLE, and QUIETLY WARM` language shared with
 *     Color v4 — both prompts now use the same canonical mood-anchor for
 *     consistency. AIRY DAYLIGHT animation reference (Howl's flower fields,
 *     Kiki's summer skies) replaces v4's broader atmospheric reference,
 *     pinning Pro to the bright-airy register that matches her source
 *     mood. Dry chalky restrained mark register made explicit (NOT dense
 *     scratchy crosshatching, NOT painterly oil bravura). Validated in
 *     Krea by Jeff against the bouquet portrait.
 *
 * **Lesson:** read-and-develop beats swap-and-replace for presets that
 * touch structural elements of the input. The swap framing makes Pro
 * invent a replacement; the read-and-develop framing makes Pro identify
 * what the artist is doing and push it further. See lesson #8 in
 * `docs/PROMPT_LESSONS.md`. The mood-anchor pattern shared with Color v4
 * (lesson #7) is also applied here.
 *
 * Multi-paragraph body; the aspect-ratio sentence is appended as its own
 * trailing paragraph at render time per AGENTS.md §3.
 */
const BACKGROUND_PROMPT_BODY = `This painting needs its background developed and improved — not replaced with a different setting. Read the source carefully first. What is the artist doing? Is this an interior or an outdoor scene? What compositional ideas is she working with — vertical framing elements, color fields, repeating motifs (like polka dots, stripes, pattern), layered passages, window framing, architectural rhythm? What spatial logic is she using? What is she TRYING to achieve in the background?

Your job is to identify her compositional intent and DEVELOP it — push her existing ideas further, refine them, deepen them, make them more resolved. Not to invent a different scene.

If she's painted an INTERIOR with framing devices (windows, walls, curtains, vertical compositional elements, decorative motifs like polka dots): the new background stays an interior, develops her existing framing, refines her motif use, deepens her color field choices, makes her compositional rhythm more intentional. Same kind of interior, same compositional ideas, just resolved further.

If she's painted an OUTDOOR scene (landscape, sky, foliage, outdoor space): the new background stays outdoor, develops her existing landscape ideas, refines her atmospheric depth, makes her spatial logic more resolved. Same kind of outdoor scene, just developed further.

Whatever direction she's working in — stay in it. Indoor stays indoor. Outdoor stays outdoor. Her compositional ideas (motifs, framing, rhythm, color fields) are preserved and developed, not replaced.

CRITICAL on mood: this artist's work is PEACEFUL, GENTLE, and QUIETLY WARM. Her paintings have a calm daydream quality — soft warmth, airy light, gentle cheerfulness, contemplative ease. The background development must preserve that peaceful airy feeling. Not moody. Not earthy-dim. Not autumnal. Not olive-toned. Not gloomy. Light and warm, same emotional register as her source.

What you're enriching is the visual richness — atmospheric depth, color sophistication, compositional resolution. Channel the painted-background sensibility of 1980s and 1990s hand-animated films in their AIRY DAYLIGHT register: Howl's flower fields, Kiki's summer skies, Totoro daylight forests, Belle's sunlit interiors. Bright, airy, gently saturated, painterly daylight — only as a sensibility for color depth and atmospheric mood, never for setting choice or rendering style.

Render everything entirely in HER style. Her exact brushwork, her exact marks, her exact level of finish, her exact line work. She works in dry media — chalky pastel, charcoal, colored pencil — but RESTRAINED. Most of her background is SOFT CHALKY COLOR FIELD with sparse confident gestural marks as accents. NOT dense scratchy crosshatching. NOT painterly oil bravura. Quiet chalky color does most of the work; one or two confident dry strokes suggest place. Her existing motifs (polka dots, vertical strokes, etc) stay in her register — chalky, gestural, not cleaned up.

The SHAPES of background elements come from her hand, not from realistic construction. Simplified, gestural, slightly wonky, flattened. A window is a wobbling rough quadrilateral. Architectural elements have approximate angles. Foliage is loose suggestion, not literal trees. Geometry is hers, not constructed.

If she has decorative motifs (polka dots, repeating shapes, pattern marks): preserve those motifs as part of the composition. Don't remove them. Don't replace them. Develop them — refine their rhythm, place them more intentionally, integrate them more deeply with the surrounding color fields.

Do NOT change the type of setting. Indoor stays indoor. Outdoor stays outdoor. Do NOT replace her composition with a different one. Do NOT abandon her framing devices, motifs, or compositional ideas. Do NOT render objects literally or use accurate perspective. Do NOT use dense scratchy marks. Do NOT use loose oil-painting brushwork. Do NOT use cel-animation finish. Do NOT shift mood toward moody, earthy, autumnal, olive-toned. Do NOT darken the painting.

The figure, subject, foreground composition, palette family, lighting direction, and brushwork on the foreground all stay IDENTICAL to the input. Only the background DEVELOPS — same kind of place, same compositional ideas, just made more resolved and atmospherically rich, in her dry chalky restrained register.

The result should look like the same painting after she made one focused background development pass — same intent, same compositional ideas, more resolved.`;

// ---------------------------------------------------------------------------
// Templated path — for Lighting solo and Color+Lighting combos.
// ---------------------------------------------------------------------------

/** What each preset commands the model to vary, when checked. Ambiance and
 *  Background have placeholders here for type-completeness but are never
 *  rendered through the templated path — their early-returns in
 *  `buildPrompt` catch them first. */
const PRESET_LABEL: Record<Preset, string> = {
  color: "the colors and palette (handled separately)",
  ambiance: "the atmospheric depth and ambient presence (handled separately)",
  lighting: "the lighting and mood",
  background: "the background environment and setting (handled separately)",
};

/** Master preserve list, in stable rendering order. Each item has an `id` so
 * presets can selectively remove it when that aspect is being varied. */
const PRESERVE_LIST: ReadonlyArray<{ id: string; phrase: string }> = [
  { id: "color", phrase: "the original colors and palette" },
  { id: "brushwork", phrase: "the brushwork, mark-making, and drawing style" },
  { id: "composition", phrase: "the composition and framing" },
  { id: "subject", phrase: "the subject and what is depicted" },
  { id: "finish", phrase: "the level of finish" },
  { id: "value", phrase: "the value structure" },
  { id: "lighting", phrase: "the lighting and mood" },
  { id: "background", phrase: "the background and setting" },
];

/** Which preserve-list `id`s a given preset removes when checked. A preset
 * can remove more than its own name (e.g. lighting also removes "value"
 * because changing lighting necessarily changes values). Ambiance and
 * Background entries are unused — both bypass the templated path. */
const PRESET_REMOVES_FROM_PRESERVE: Record<Preset, ReadonlyArray<string>> = {
  color: [], // unreachable — color has its own prompt body (v4 dominator)
  ambiance: [], // unreachable — ambiance has its own prompt body
  lighting: ["lighting", "value"],
  background: [], // unreachable — background has its own prompt body
};

export interface BuildPromptArgs {
  presets: ReadonlyArray<Preset>;
  aspectRatio: string;
}

export function buildPrompt({ presets, aspectRatio }: BuildPromptArgs): string {
  // 1. Empty → the validated v0 prompt (verbatim — Zuzi approved this during
  //    smoke runs; do not paraphrase).
  if (presets.length === 0) {
    return `This painting is shown as the input image. Reimagine it with new colors of your own choosing — pick whatever colors you think will make this painting as beautiful as possible. Preserve the brushwork, drawing style, marks, composition, subject, level of finish, and value structure exactly. Only the colors change. Match the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 2. Ambiance dominates — when checked, the dedicated v8 style-continuation
  //    prompt fires. Other checked presets are intentionally subsumed because
  //    mixing ambiance's "continue in her style" directive with e.g. color's
  //    "vary the palette" produces contradictory instructions.
  if (presets.includes("ambiance")) {
    return `${AMBIANCE_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 3. Background dominates — same reason. The locked body's preserve list
  //    keeps palette family and lighting direction IDENTICAL, which would
  //    clash with Color and Lighting respectively. If Zuzi wants compound
  //    edits she runs two passes (Background, then Color on a favorite).
  if (presets.includes("background")) {
    return `${BACKGROUND_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 4. Color dominates — the locked body's preserve list explicitly includes
  //    "lighting direction, and mood", which would contradict a Lighting
  //    checkbox checked alongside Color. Same dominator pattern as Ambiance
  //    and Background. If Zuzi wants Color + Lighting compound edits, she
  //    runs two passes (Color first, then Lighting on a favorite).
  if (presets.includes("color")) {
    return `${COLOR_PROMPT_BODY}\n\nMatch the input aspect ratio exactly (${aspectRatio}).`;
  }

  // 5. Templated path — only reached for `['lighting']` solo today. Lighting
  //    hasn't been Krea-iterated yet; when it is, port to a dedicated body
  //    + early-return, same as the other three. The templated builder will
  //    then have no callers and can be deleted.
  //
  //    Project to a deduped, stably-ordered array of valid presets. The
  //    filter ensures that a malformed input (already validated upstream,
  //    but still) can't punch through to the prompt.
  const checked = PRESET_ORDER.filter((p) => presets.includes(p));

  const varyPhrases = checked.map((p) => PRESET_LABEL[p]);
  const varyList = joinPhrases(varyPhrases);

  const removed = new Set<string>();
  for (const p of checked) {
    for (const id of PRESET_REMOVES_FROM_PRESERVE[p]) removed.add(id);
  }
  const preservePhrases = PRESERVE_LIST.filter((item) => !removed.has(item.id)).map(
    (item) => item.phrase,
  );
  const preserveSentence =
    preservePhrases.length > 0 ? ` Preserve ${joinPhrases(preservePhrases)} exactly.` : "";

  return `This painting is shown as the input image. Reimagine ${varyList}, picking whatever choices you think will make this painting as beautiful as possible.${preserveSentence} Match the input aspect ratio exactly (${aspectRatio}).`;
}

/** Oxford-comma list joiner: ["a"] → "a"; ["a","b"] → "a and b";
 * ["a","b","c"] → "a, b, and c". */
function joinPhrases(phrases: ReadonlyArray<string>): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}
