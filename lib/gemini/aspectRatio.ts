/**
 * Pure, deterministic aspect-ratio snapping for Gemini image generation.
 *
 * Gemini Pro Image accepts only a discrete set of aspect ratios. We snap the input image's
 * (w, h) to the nearest supported ratio in log-distance and pass it via
 * `config.imageConfig.aspectRatio` on every generateContent call. Output ratio MUST equal
 * input ratio — see AGENTS.md "Output aspect ratio always equals input aspect ratio".
 *
 * Log distance (vs linear) is the right metric: ratios live multiplicatively, so 1.5 and
 * 2/3 should be equally far from 1:1, which they are in log space (and aren't in linear).
 */

export const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

export type SupportedAspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

interface Candidate {
  label: SupportedAspectRatio;
  ratio: number; // w / h
}

const CANDIDATES: Candidate[] = [
  { label: "1:1", ratio: 1 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "4:5", ratio: 4 / 5 },
  { label: "5:4", ratio: 5 / 4 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "21:9", ratio: 21 / 9 },
];

/**
 * Flip a "W:H" aspect-ratio label to "H:W". Used by the InputBar's
 * "Aspect: Match | Flip" toggle: portrait sources generate landscape
 * outputs and vice versa under flip mode. 1:1 stays 1:1.
 *
 * Input MUST already be a snapped supported ratio (one of
 * `SUPPORTED_ASPECT_RATIOS`). The flipped result is also guaranteed to
 * be in the supported set because the supported set is closed under W:H
 * swap (every entry has its mirror — 4:5 ↔ 5:4, 9:16 ↔ 16:9, etc.).
 *
 * Edge case: 21:9 is in the supported set but 9:21 is NOT — Gemini
 * doesn't accept that ratio. Calling flip on 21:9 returns 9:21 anyway
 * and the Gemini call would 400; the caller is responsible for not
 * generating against 21:9 sources in flip mode (current product
 * doesn't support 21:9 source uploads, so this is theoretical).
 */
export function flipAspectRatio(ratio: string): string {
  const m = ratio.match(/^(\d+):(\d+)$/);
  if (!m) {
    throw new Error(`flipAspectRatio: invalid ratio "${ratio}"`);
  }
  const w = m[1];
  const h = m[2];
  // 1:1 (and any other W==H ratio, though only 1:1 is in the supported
  // set) is its own mirror. Returning early avoids a needless allocation
  // and keeps the result string-identical to the input.
  if (w === h) return ratio;
  return `${h}:${w}`;
}

export function nearestSupportedAspectRatio(
  width: number,
  height: number,
): SupportedAspectRatio {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `nearestSupportedAspectRatio: invalid dimensions ${width}x${height}`,
    );
  }
  const logTarget = Math.log(width / height);
  let best = CANDIDATES[0];
  let bestDist = Math.abs(logTarget - Math.log(best.ratio));
  for (let i = 1; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    const d = Math.abs(logTarget - Math.log(c.ratio));
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best.label;
}
