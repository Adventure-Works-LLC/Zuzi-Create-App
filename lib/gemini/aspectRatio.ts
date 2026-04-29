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
