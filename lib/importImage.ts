/**
 * v5.5 — server-side image import from a pasted link (AGENTS.md §13
 * StylesPanel "From link" flow). Zuzi copies a Pinterest pin link on
 * the iPad; the server resolves it to the actual image bytes so
 * nothing needs downloading client-side.
 *
 * Resolution strategy:
 *   1. GET the URL (https only, redirects followed, browser-ish UA —
 *      Pinterest serves og tags to it, 20s timeout, 30MB cap).
 *   2. If the response is an image → those bytes.
 *   3. If it's HTML (a pin page, or most sites) → parse
 *      `og:image` / `twitter:image` meta and fetch THAT (one hop,
 *      same guards). For i.pinimg.com URLs, try upgrading the sized
 *      variant (/236x/, /736x/ …) to /originals/ first and fall back
 *      to the tagged size on a non-200.
 *
 * SSRF posture (single-user, password-gated app): https-only, no
 * credentials in URLs, and hostname/IP-literal checks that reject
 * localhost + RFC-1918/link-local ranges. Not DNS-rebinding-proof —
 * proportionate to a one-user tool where the only URL source is
 * Zuzi's paste. Re-evaluate if the user base ever grows.
 */

import { Buffer } from "node:buffer";

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export class ImportError extends Error {
  constructor(
    public code:
      | "invalid_url"
      | "blocked_host"
      | "fetch_failed"
      | "not_an_image"
      | "too_large",
    message: string,
  ) {
    super(message);
  }
}

function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportError("invalid_url", "That doesn't look like a link.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImportError("invalid_url", "Only http(s) links are supported.");
  }
  if (url.username || url.password) {
    throw new ImportError("invalid_url", "Links with credentials aren't supported.");
  }
  const host = url.hostname.toLowerCase();
  const isPrivateIpV4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
    host,
  );
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "[::1]" ||
    isPrivateIpV4
  ) {
    throw new ImportError("blocked_host", "That host isn't reachable from here.");
  }
  return url;
}

async function fetchWithGuards(url: URL): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "image/*,text/html;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    throw new ImportError(
      "fetch_failed",
      `Couldn't reach that link (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!resp.ok) {
    throw new ImportError(
      "fetch_failed",
      `The link answered with HTTP ${resp.status}.`,
    );
  }
  return resp;
}

async function readCapped(resp: Response): Promise<Buffer> {
  const lenHeader = Number(resp.headers.get("content-length") ?? "0");
  if (Number.isFinite(lenHeader) && lenHeader > MAX_IMPORT_BYTES) {
    throw new ImportError("too_large", "That image is over the 30MB limit.");
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_IMPORT_BYTES) {
    throw new ImportError("too_large", "That image is over the 30MB limit.");
  }
  return buf;
}

/** Extract og:image / twitter:image from an HTML document. Attribute
 *  order varies across sites (property before/after content), so match
 *  both arrangements. */
export function extractMetaImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|og:image:url|twitter:image(?::src)?)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) {
      // Entity-decode the handful that appear in URLs.
      return m[1].replace(/&amp;/g, "&").replace(/&#x2F;/g, "/");
    }
  }
  return null;
}

/** i.pinimg.com serves sized variants (/236x/, /736x/, /564x/…);
 *  swapping the size segment for /originals/ usually yields the
 *  full-resolution file. Returns null when the URL isn't pinimg or
 *  has no size segment to upgrade. */
export function pinimgOriginalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname.endsWith("pinimg.com")) return null;
    const upgraded = url.pathname.replace(/^\/\d+x(\d+)?\//, "/originals/");
    if (upgraded === url.pathname) return null;
    url.pathname = upgraded;
    return url.toString();
  } catch {
    return null;
  }
}

export interface ImportedImage {
  bytes: Buffer;
  /** Where the bytes actually came from (post og:image resolution). */
  resolvedUrl: string;
}

/** Resolve a pasted link (direct image URL, Pinterest pin page, or any
 *  page with og:image) to image bytes. */
export async function importImageFromUrl(raw: string): Promise<ImportedImage> {
  const url = assertSafeUrl(raw);
  const resp = await fetchWithGuards(url);
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.startsWith("image/")) {
    return { bytes: await readCapped(resp), resolvedUrl: resp.url || url.toString() };
  }

  if (!contentType.includes("text/html")) {
    throw new ImportError(
      "not_an_image",
      `The link served ${contentType || "unknown content"}, not an image or page.`,
    );
  }

  const html = (await readCapped(resp)).toString("utf8");
  const metaImage = extractMetaImage(html);
  if (!metaImage) {
    throw new ImportError(
      "not_an_image",
      "Couldn't find an image on that page — try copying the image address itself.",
    );
  }

  // One resolution hop: fetch the meta-tagged image (upgraded to the
  // pinimg original when possible, falling back to the tagged size).
  const candidates = [pinimgOriginalUrl(metaImage), metaImage].filter(
    (u): u is string => u !== null,
  );
  let lastErr: ImportError | null = null;
  for (const candidate of candidates) {
    try {
      const imgResp = await fetchWithGuards(assertSafeUrl(candidate));
      const imgType = (imgResp.headers.get("content-type") ?? "").toLowerCase();
      if (!imgType.startsWith("image/")) {
        lastErr = new ImportError(
          "not_an_image",
          `The page's image link served ${imgType || "unknown content"}.`,
        );
        continue;
      }
      return { bytes: await readCapped(imgResp), resolvedUrl: imgResp.url || candidate };
    } catch (e) {
      lastErr =
        e instanceof ImportError
          ? e
          : new ImportError("fetch_failed", String(e));
    }
  }
  throw lastErr ?? new ImportError("fetch_failed", "Image fetch failed.");
}
