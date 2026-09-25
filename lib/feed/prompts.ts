/**
 * v7 Zuzi's Scroll — every prompt the feed sends (AGENTS.md §18).
 *
 * Validated in the Sept 25 2026 lab against her real paintings and Jeff's
 * review. The two "her version" prompts are what hold her look — keep the
 * "draw exactly as she draws them" and "not cleaner, cuter or more
 * illustrated" clauses; they are load-bearing.
 */

import { castMenu } from "./cast";

export interface InventedBrief {
  title: string;
  era: string;
  date: string;
  medium: string;
  aspect: "4:5" | "5:4";
  scene: string;
  cast: string[];
}

/** An invented masterpiece: a painting that doesn't exist, museum-grade. */
export function originalPrompt(b: InventedBrief): string {
  return `A museum masterpiece: a ${b.era} painting, ${b.date}, ${b.medium}. ${b.scene}. Painted with the full mastery, surface and material character of the best works of that period, as if it hung in a major museum. Show the whole painting straight-on, edge to edge, with no frame, no wall, no text and no signature.`;
}

const HER_HAND =
  "her characters, drawn exactly as she draws them (the same head shapes, the same eyes placed and drawn exactly the way she draws them, the same noses, cheeks, mouths, hands and proportions), her way of simplifying a setting, and her surface (flat chalky brush marks, dark wobbly outlines, flat color areas)";

/** Her version of an invented masterpiece. Image 1 = the painting; the rest = her paintings. */
export function hersFromInventedPrompt(paletteText: string): string {
  return `Image 1 is a painting. The other images are paintings by one contemporary artist. Make HER new painting that takes the idea, the arrangement and the mood of image 1 and makes it entirely her own: ${HER_HAND}. For this one, paint it in a bold palette of ${paletteText}, confident and saturated where she would be. It must not be drawn in a cleaner, cuter or more illustrated style. It should look like a painting she made after looking at image 1 for a long time.`;
}

/** Her version of a museum painting — borrows the bones, never a copy or parody. */
export function hersFromMuseumPrompt(paletteText: string): string {
  return `Image 1 is an old painting from a museum. The other images are paintings by one contemporary artist. Make HER new painting that borrows only the bones of image 1 — its composition, the arrangement of figures, the gesture and the mood — and makes it entirely her own: ${HER_HAND}. For this one, paint it in a bold palette of ${paletteText}, confident and saturated where she would be. It must not look like a copy or a parody of image 1, and must not be drawn in a cleaner, cuter or more illustrated style. It should look like a painting she made after looking at image 1 for a long time.`;
}

/** One palette dot: same painting, new colors. */
export function recolorPrompt(paletteText: string): string {
  return `Repaint only the colors of this painting. Keep every shape, line, face, eye, hand, brush mark and the whole composition exactly the same — the drawing must not change at all. New palette: ${paletteText}. Make the color museum-grade: a clear dominant hue, nuanced temperature shifts inside each color area, colored neutrals instead of grey, and complements used sparingly, the way a great colorist handles color. Keep the painted surface and the dark wobbly outlines.`;
}

const ERAS = [
  "Byzantine icon", "Early Italian Renaissance", "Northern Renaissance", "Dutch Golden Age genre painting",
  "Dutch Golden Age still life", "French Rococo", "Romanticism", "French Realism", "Impressionism",
  "Post-Impressionism", "Nabis", "Fauvism", "German Expressionism", "School of Paris", "New Objectivity",
  "Mexican Modernism", "Surrealism", "American Scene painting", "Bay Area Figurative", "1960s Pop figuration",
  "Neo-Expressionism", "Edo-period Japanese painting", "Mughal miniature", "Contemporary figurative painting",
];

/** The idea-writer: briefs for invented masterpieces that rhyme with her world. */
export function ideaWriterPrompt(n: number, avoidTitles: string[]): string {
  return `You write briefs for "invented masterpieces": paintings that do not exist but could hang in a major museum, each one a starting point for a contemporary painter named Zuzi to paint her own version.

Her world, from her own paintings (use these keys for "cast"):
${castMenu()}

Her recurring moods: gentle deadpan humor, sleepiness, tenderness, small absurd moments in cafés, kitchens, bedrooms, fields and stables.

Write ${n} briefs. Rules:
- Each brief is a specific, original scene that rhymes with her world (her people, horses, cats, cafés, kitchens, boots, sleepers, hands from the sky) but is a NEW situation she has never painted.
- Never describe or echo a famous existing painting or its best-known composition. Each must be an original composition.
- Spread the eras widely; use a different era for each brief, chosen from: ${ERAS.join("; ")}.
- Write the scene the way a museum catalogue would describe the painting: concrete subjects, setting, light, one telling detail. 1–2 sentences, no more than 60 words.
- "cast" lists 1–3 keys from the list above whose characters or settings her version should use.
- "aspect" is "4:5" (portrait) or "5:4" (landscape), whichever suits the scene.
- Do not reuse any of these titles or their ideas: ${avoidTitles.length ? avoidTitles.join("; ") : "(none yet)"}.

Return only a JSON array of ${n} objects with keys: title, era, date, medium, aspect, scene, cast.`;
}

/** The museum judge: which public-domain paintings are strong starting points for her. */
export function museumJudgePrompt(count: number): string {
  return `You pick paintings for Zuzi, a contemporary painter, to paint her own version of. You will see ${count} numbered images from museum collections, each with its title and artist.

Her world, from her own paintings (use these keys for "cast"):
${castMenu()}

Keep a painting only if ALL of these are true:
- It is a painting (not a vase, snuffbox, textile, manuscript page, calligraphy or photograph).
- Its subject rhymes with her world: people sleeping, eating, drinking, dancing, cooking, sitting at tables, riding or tending horses, cats, boots, cafés, kitchens, bedrooms, picnics, performers, or a strong single figure.
- It has a strong, readable composition that would still work simplified into flat shapes.
- It is not a formal devotional or religious scene, a battle, or a landscape with no figures or animals.

Return only a JSON array with one object per image, in order: {"i": number, "keep": boolean, "cast": [1–3 keys], "rhyme": "a few words naming what it rhymes with in her work"}.`;
}
