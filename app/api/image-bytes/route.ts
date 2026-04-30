/**
 * GET /api/image-bytes?key=<r2-key>
 *
 * Streams the R2 object's bytes through our app server. Same-origin to the
 * client, which sidesteps the CORS wall that blocks a direct
 * `fetch("https://...r2.cloudflarestorage.com/...")` from browser JS.
 *
 * Why this exists: the Lightbox's Share + Use-as-Source flows need the image
 * bytes in browser memory (so we can construct a `File` and either invoke
 * `navigator.share({files:[file]})` or POST it as a new source). The
 * straightforward path — `fetch(signedUrl).blob()` — fails on iPad PWA
 * because R2 doesn't return CORS headers by default for cross-origin
 * `fetch` (even though `<img src="signedUrl">` works fine because img
 * loads don't enforce CORS). The browser surfaces this as
 * `TypeError: Load failed` with no useful detail.
 *
 * Routing through our server eliminates the entire class of failures:
 *   - CORS: same-origin, gone.
 *   - Expired signed URLs: server uses `getObject` with credentials, no
 *     URL TTL involved.
 *   - Service worker interception: the SW skips `/api/*` (see
 *     `scripts/sw-template.js`), so this endpoint is never cached.
 *
 * Auth model: same as /api/image-url — gated on session, key-prefix
 * validated. Path-traversal defense lives here, not in r2.ts.
 *
 * Response: binary stream with `Content-Type` matching the key suffix
 * (image/jpeg for outputs, image/webp for thumbs, image/jpeg for
 * inputs). `Cache-Control: private, no-store` so neither browser nor
 * any intermediary caches the binary (the equivalent CDN cache for the
 * direct-R2 path is opt-in via the signed URL's lifetime — but for
 * client-side bytes destined for File construction we want fresh every
 * time).
 *
 * runtime = 'nodejs' is required: r2.getObject pulls in @aws-sdk/client-s3
 * (Node-only), per AGENTS.md §2.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { getObject } from "@/lib/storage/r2";

export const runtime = "nodejs";

const ALLOWED_PREFIXES = ["inputs/", "outputs/", "thumbs/"] as const;

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false; // unsealable cookie → unauthenticated
  }
}

function isValidKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  if (key.length > 256) return false;
  if (key.includes("..") || key.includes("\\")) return false;
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;
}

/** Best-effort Content-Type from the key suffix. The R2 PUT path sets the
 *  same content-type at upload time, but rather than round-trip an extra
 *  HEAD against R2 we infer here — keys are tightly controlled by our own
 *  upload pipeline (sharp writes JPEG to inputs/* and outputs/*, WEBP to
 *  thumbs/*), so the suffix is authoritative. */
function contentTypeForKey(key: string): string {
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".png")) return "image/png";
  // JPEG is the dominant case (inputs/* and outputs/*).
  return "image/jpeg";
}

export async function GET(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (!isValidKey(key)) {
    return NextResponse.json(
      {
        error: "invalid_key",
        detail: `key must start with one of: ${ALLOWED_PREFIXES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await getObject(key);
  } catch (e) {
    return NextResponse.json(
      {
        error: "r2_read_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  // Convert to Uint8Array for Next.js Response — Buffer works on Node but
  // typings prefer the standard byte view.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentTypeForKey(key),
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      // Defense-in-depth against MIME sniffing surprises across iOS
      // Safari versions.
      "x-content-type-options": "nosniff",
    },
  });
}
