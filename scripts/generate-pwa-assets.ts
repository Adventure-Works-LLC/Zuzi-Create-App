/**
 * Generate PWA icons + Apple touch icon + Apple splash images.
 *
 * Run: `node --import tsx scripts/generate-pwa-assets.ts`
 *
 * Output:
 *   public/apple-touch-icon.png   180x180  (iOS home-screen icon)
 *   public/icon-192.png           192x192  (PWA manifest)
 *   public/icon-512.png           512x512  (PWA manifest)
 *   public/icon-maskable-512.png  512x512  (PWA manifest, with safe zone)
 *   public/apple-splash-2048-2732.png   iPad Pro 12.9" portrait
 *   public/apple-splash-2732-2048.png   iPad Pro 12.9" landscape
 *   public/apple-splash-1668-2388.png   iPad Pro 11"   portrait
 *   public/apple-splash-2388-1668.png   iPad Pro 11"   landscape
 *   public/apple-splash-1668-2224.png   iPad Air       portrait
 *   public/apple-splash-2224-1668.png   iPad Air       landscape
 *
 * Design language (per docs/PALETTE.md):
 *   bg     #0E0C0A  (warm near-black)
 *   accent #C9A878  (warm brass)
 *   text   #EDE7DE  (warm cream)
 *   serif display ("Zuzi" wordmark) using a generic serif fallback that librsvg
 *   resolves cleanly — exact Fraunces requires the font binary, which isn't
 *   bundled here; the silhouette of a classical serif is enough for icon scale.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT_DIR = resolve("public");
const BG = "#0E0C0A";
const ACCENT = "#C9A878";
const TEXT = "#EDE7DE";

function appIconSvg(size: number, mask = false): string {
  // Soft warm radial bloom behind a brass "Z" monogram.
  // For maskable, keep the focal element well within the inner 80% safe zone.
  const safeZoneScale = mask ? 0.62 : 0.78;
  const fontSize = Math.round(size * safeZoneScale);
  const blobR = Math.round(size * 0.48);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="bloom" cx="50%" cy="42%" r="55%">
      <stop offset="0%"  stop-color="${ACCENT}" stop-opacity="0.18"/>
      <stop offset="60%" stop-color="${ACCENT}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <circle cx="${size / 2}" cy="${size * 0.46}" r="${blobR}" fill="url(#bloom)"/>
  <text x="50%" y="50%"
    text-anchor="middle"
    dominant-baseline="central"
    font-family="Georgia, 'Times New Roman', 'Cormorant Garamond', serif"
    font-style="italic"
    font-weight="500"
    font-size="${fontSize}"
    fill="${ACCENT}"
    letter-spacing="-0.02em"
  >Z</text>
</svg>`;
}

function splashSvg(width: number, height: number): string {
  // Centered "Zuzi Studio" wordmark on warm-near-black with a soft warm bloom.
  const isPortrait = height >= width;
  const wordSize = Math.round(Math.min(width, height) * (isPortrait ? 0.09 : 0.078));
  const cy = isPortrait ? height * 0.46 : height * 0.48;
  const bloomR = Math.round(Math.min(width, height) * 0.55);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="bloom" cx="50%" cy="46%" r="60%">
      <stop offset="0%"  stop-color="${ACCENT}" stop-opacity="0.10"/>
      <stop offset="55%" stop-color="${ACCENT}" stop-opacity="0.025"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${BG}"/>
  <circle cx="${width / 2}" cy="${cy}" r="${bloomR}" fill="url(#bloom)"/>
  <text x="50%" y="${cy}"
    text-anchor="middle"
    dominant-baseline="central"
    font-family="Georgia, 'Times New Roman', serif"
    font-weight="400"
    font-style="italic"
    font-size="${wordSize}"
    fill="${TEXT}"
    letter-spacing="-0.02em"
  >Zuzi Studio</text>
</svg>`;
}

async function writeIcon(filename: string, svg: string): Promise<void> {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(resolve(OUT_DIR, filename), png);
  console.log(`  ${filename}  (${png.length.toLocaleString()} bytes)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log("icons:");
  await writeIcon("apple-touch-icon.png", appIconSvg(180));
  await writeIcon("icon-192.png", appIconSvg(192));
  await writeIcon("icon-512.png", appIconSvg(512));
  await writeIcon("icon-maskable-512.png", appIconSvg(512, true));

  console.log("\nsplash images:");
  // iPad Pro 12.9"
  await writeIcon("apple-splash-2048-2732.png", splashSvg(2048, 2732));
  await writeIcon("apple-splash-2732-2048.png", splashSvg(2732, 2048));
  // iPad Pro 11"
  await writeIcon("apple-splash-1668-2388.png", splashSvg(1668, 2388));
  await writeIcon("apple-splash-2388-1668.png", splashSvg(2388, 1668));
  // iPad Air / standard iPad
  await writeIcon("apple-splash-1668-2224.png", splashSvg(1668, 2224));
  await writeIcon("apple-splash-2224-1668.png", splashSvg(2224, 1668));

  console.log("\nDone. Files in public/.");
}

main().catch((e) => {
  console.error("generate-pwa-assets failed:", e);
  process.exit(1);
});
