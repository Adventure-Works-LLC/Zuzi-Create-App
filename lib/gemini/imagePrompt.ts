/**
 * The single shared image prompt for the "make this beautiful" tool.
 *
 * Used by `scripts/smoke.ts` and (in Prompt 3) by `lib/gemini/runIteration.ts`. The same
 * string is sent on every image-generation call — there is no planner, no per-tile
 * directive, no taxonomy of color schemes. The model picks the colors. Temperature stays
 * at default (1.0) so 9 parallel calls produce 9 different results.
 *
 * `aspectRatio` is also passed via `config.imageConfig.aspectRatio` —
 * belt-and-suspenders. See AGENTS.md Section 3 ("Output aspect ratio always equals input
 * aspect ratio") and Section 4 ("Make this beautiful" tool).
 */
export function buildImagePrompt(aspectRatio: string): string {
  return `This painting is shown as the input image. Reimagine it with new colors of your own choosing — pick whatever colors you think will make this painting as beautiful as possible. Preserve the brushwork, drawing style, marks, composition, subject, level of finish, and value structure exactly. Only the colors change. Match the input aspect ratio exactly (${aspectRatio}).`;
}
