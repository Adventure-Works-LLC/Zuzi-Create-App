/**
 * v7 Zuzi's Scroll — her cast (AGENTS.md §18).
 *
 * The paintings of hers that "her version" renders are built from: each
 * key names one of her own paintings (a Studio source, stored in R2 at
 * inputs/<id>.jpg). The idea-writer and the museum judge pick 1–3 keys per
 * card; the renderer passes those paintings as the character references.
 *
 * Casting is what keeps her look (Sept 2026 lab): given her actual
 * paintings, GPT Image 2 keeps her side-set eyes, wonky horses and chef;
 * described in words, every model drifts to stock storybook characters.
 *
 * If a source is ever hard-deleted, its key just drops out (see
 * castImages in engine.ts) — the card still renders from the others.
 */

export interface CastMember {
  sourceId: string;
  label: string;
}

export const CAST: Record<string, CastMember> = {
  hanging: { sourceId: "01KZPTPB9KH2F0RGJTWQ0D7G2P", label: "a man with a red tie being lifted by a giant hand from the clouds" },
  knight: { sourceId: "01KZVRB1SHHXQ5PH1YT1JG59PF", label: "a little knight with a big yellow spiral shield and a lance on a pink horse, mauve mountain behind" },
  cat: { sourceId: "01KYBFX68W06ZBQBQED8AT3ERF", label: "a woman peeling potatoes at a kitchen table while her purple cat stretches" },
  chef: { sourceId: "01KYBDJKP0WGZD2FDAYXXZM0G7", label: "a chef in a white cap frying an egg at a café counter" },
  bottles: { sourceId: "01KYGN9S0VZ9VKNQTAQT1QMPZW", label: "a man asleep face-down at a table among wine bottles" },
  flowergirl: { sourceId: "01KZPVPYYB6C10DRDYDT4H99ZG", label: "a girl with a flower in her hair, butterflies around her" },
  yawn: { sourceId: "01KYB5K18GEAXDVXHPRDEBVZ3Y", label: "a woman yawning with her hand over her mouth" },
  tux: { sourceId: "01KYGP9X5564Q0TH3FMD1F5298", label: "a man in a black waistcoat sitting on a stool, knees wide" },
  horses: { sourceId: "01KZVQQD05WTT6Y4GF4EX3V9WY", label: "galloping pink and grey horses under a mauve mountain" },
  sleeper: { sourceId: "01KYB53TJDNVDEKEPAHFXEZ1GX", label: "a woman asleep on a table under a string of lights, holding a small glass" },
  boots: { sourceId: "01KXV57W6CT2ZTF3BGCX1DSGKS", label: "a pair of pink boots" },
  braids: { sourceId: "01KXV1HSZGKX0PJKVY34359AVB", label: "a girl with long braids in a pink dress, arms out, mid-tumble" },
  glasses: { sourceId: "01KYBBEMCHF7JR5Q27BCQD8A4K", label: "a big round face with glasses and a blue hat" },
};

export const CAST_KEYS = Object.keys(CAST);

export function isCastKey(v: unknown): v is string {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CAST, v);
}

/** One line per cast member, for the idea-writer and museum-judge prompts. */
export function castMenu(): string {
  return CAST_KEYS.map((k) => `- ${k}: ${CAST[k].label}`).join("\n");
}
