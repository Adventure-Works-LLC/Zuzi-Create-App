/**
 * v7 Zuzi's Scroll — the palette dots (AGENTS.md §18). Client-safe: zero
 * imports, so the feed page can render the chips.
 *
 * Five palettes come from her own finished paintings (her Instagram,
 * Sept 2026 — bold grounds, not the muted look of her app sketches); five
 * come from great colorists so she's never trapped in her own range.
 * `text` is what the recolor model is told; `chips` are the three colors
 * the dot shows.
 */

export type PaletteKey =
  | "orange"
  | "cobalt"
  | "lemon"
  | "pink"
  | "chalk"
  | "matisse"
  | "bonnard"
  | "avery"
  | "nabis"
  | "oldmaster";

export interface Palette {
  name: string;
  src: "hers" | "colorist";
  chips: [string, string, string];
  text: string;
}

export const PALETTES: Record<PaletteKey, Palette> = {
  orange: { name: "Orange Room", src: "hers", chips: ["#E8742A", "#2E7D4F", "#F2B8C6"], text: "a cadmium orange ground, black hair, leaf green with small white dots, pink cheeks and touches of lemon yellow" },
  cobalt: { name: "Cobalt and Butter", src: "hers", chips: ["#2F5FB3", "#F2D46B", "#D8432E"], text: "a cobalt and cerulean blue ground, butter yellow, chalk white and a single note of vermilion red" },
  lemon: { name: "Lemon and Lilac", src: "hers", chips: ["#F2E43A", "#B79AD9", "#1E1B1F"], text: "an acid lemon yellow ground with lilac, soft pink and crisp black accents" },
  pink: { name: "Pink and Mint", src: "hers", chips: ["#F09AC0", "#9FD9B8", "#D83A34"], text: "a bubblegum pink ground with mint green, warm white and small red accents" },
  chalk: { name: "Chalk and Vermilion", src: "hers", chips: ["#F1ECE2", "#E0402A", "#7FB2DC"], text: "a warm chalk-white ground with vermilion red, sky blue and a little ochre" },
  matisse: { name: "Matisse Blue", src: "colorist", chips: ["#2A3F9E", "#D8402B", "#2E8B57"], text: "ultramarine, vermilion and emerald green with black accents on a warm white, the way Matisse used color" },
  bonnard: { name: "Bonnard Afternoon", src: "colorist", chips: ["#8C6BB1", "#F2A65A", "#E7C84B"], text: "violet, apricot, golden yellow and rose in broken, glowing color, the way Bonnard used color" },
  avery: { name: "Avery Coast", src: "colorist", chips: ["#9DB39A", "#E59A86", "#5E7690"], text: "sage green, salmon pink, slate blue and ochre in flat, quiet, perfectly tuned harmonies, the way Milton Avery used color" },
  nabis: { name: "Nabis Interior", src: "colorist", chips: ["#6E3B5C", "#C99A3B", "#3E7A6A"], text: "plum, ochre, viridian and rose in close-valued, patterned tones, the way the Nabis painters used color" },
  oldmaster: { name: "Old Master Night", src: "colorist", chips: ["#4A3526", "#6B6B3A", "#C8342B"], text: "umber, olive shadow, lead white and a single vermilion accent, the way the Old Masters used color" },
};

export const HER_PALETTES: PaletteKey[] = ["orange", "cobalt", "lemon", "pink", "chalk"];
export const COLORIST_PALETTES: PaletteKey[] = ["matisse", "bonnard", "avery", "nabis", "oldmaster"];

export function isPaletteKey(v: unknown): v is PaletteKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PALETTES, v);
}

/** Three dots per card: two of her palettes and one colorist's, varied by card. */
export function pickPalettes(seed: number): PaletteKey[] {
  const h = HER_PALETTES.length;
  const a = ((seed % h) + h) % h;
  const b = (a + 2) % h;
  const c = ((seed % COLORIST_PALETTES.length) + COLORIST_PALETTES.length) % COLORIST_PALETTES.length;
  return [HER_PALETTES[a], HER_PALETTES[b], COLORIST_PALETTES[c]];
}
