/**
 * v7.2 "Painted by Matisse" (AGENTS.md §18): Matisse's own paintings, sent as
 * reference images so GPT Image 2 learns how HE draws — the same casting idea
 * that holds Zuzi's look in her versions. All public domain (1906–1913),
 * kept in R2 under `feed/matisse-refs/` with Wikimedia Commons as the fallback
 * (engine.ts matisseImages).
 *
 * Chosen for his line and shape, not his color: flat, reductive, contour-drawn
 * pictures. Softer or brushier ones (Tea, The Open Window, Woman with a Hat)
 * let the museum painting's realistic drawing back in. Clothed figures only:
 * with his nudes in the set (Dance, Le Luxe, Game of Bowls), the horse dealers
 * of Bonheur's Horse Fair came back as nude dancers (Sept 25 2026 lab).
 */

export const MATISSE_REFS = {
  harmony: { title: "The Dessert: Harmony in Red", file: "La Desserte rouge, par Henri Matisse.jpg" },
  family: { title: "The Painter's Family", file: "La famille du peintre - Henri Matisse.jpg" },
  aubergines: { title: "Interior with Aubergines", file: "Intérieur aux aubergines, Henri Matisse, 1911-12, musée de Grenoble.jpg" },
  conversation: { title: "The Conversation", file: "La Conversation, par Henri Matisse (Ermitage).jpg" },
  coffeehouse: { title: "Arab Coffeehouse", file: "Henri Matisse, 1912-13, Le café Maure (Arab Coffeehouse), oil on canvas, 176 x 210 cm, Hermitage Museum.jpg" },
  cat: { title: "Marguerite with a Black Cat", file: "Marguerite au chat noir, par Henri Matisse.jpg" },
  zorah: { title: "Zorah on the Terrace", file: "Zorah sur la terrasse, par Henri Matisse.jpg" },
  riffian: { title: "Seated Riffian", file: "Le Rifain assis, par Henri Matisse.jpg" },
  sailor: { title: "The Young Sailor II", file: "Le Jeune Marin II Henri Matisse 1906 MET.jpg" },
  wife: { title: "Portrait of the Artist's Wife", file: "Portrait de la femme de l'artiste, par Henri Matisse.jpg" },
} as const;

export type MatisseRefKey = keyof typeof MATISSE_REFS;

const ROOMS: MatisseRefKey[] = ["harmony", "family", "aubergines", "conversation", "coffeehouse"];
const PEOPLE: MatisseRefKey[] = ["cat", "zorah", "riffian", "sailor", "wife"];

export function matisseRefUrl(k: MatisseRefKey): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(MATISSE_REFS[k].file)}?width=1280`;
}

/**
 * Three references per card — a room, a person and one more — picked from the
 * card id so a card always gets the same set, while the feed rotates through
 * all ten (with one fixed set, most cards came back as Harmony in Red's red
 * room with blue vines).
 */
export function pickMatisseRefs(seed: string): MatisseRefKey[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const room = ROOMS[h % ROOMS.length];
  const person = PEOPLE[(h >>> 8) % PEOPLE.length];
  const rest = [...ROOMS, ...PEOPLE].filter((k) => k !== room && k !== person);
  return [room, person, rest[(h >>> 16) % rest.length]];
}
