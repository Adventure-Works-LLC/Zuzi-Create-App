/**
 * GET /api/image-url?key=<r2-key>
 *
 * Returns a 1-hour presigned URL for the requested R2 object. Auth-gated: only
 * authenticated sessions can request a URL. Once issued, the URL is bearer-style
 * (works for its TTL even without a session). See AGENTS.md §7 for the full
 * privacy / threat model.
 *
 * Allowed key prefixes (path-traversal defense):
 *   inputs/<ulid>.jpg
 *   outputs/<iter>/<idx>.jpg
 *   thumbs/<iter>/<idx>.webp
 * Anything else is rejected with 400.
 *
 * Response: { url: string, expiresAt: number (unix ms) }
 *
 * runtime = 'nodejs' is required: signedUrlFor pulls in @aws-sdk/client-s3 +
 * s3-request-presigner (both Node-only).
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { signedUrlFor } from "@/lib/storage/r2";

export const runtime = "nodejs";

const TTL_SECONDS = 3600;
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

  let signed: string;
  try {
    signed = await signedUrlFor(key, TTL_SECONDS);
  } catch (e) {
    return NextResponse.json(
      {
        error: "signing_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  return NextResponse.json({ url: signed, expiresAt }, { status: 200 });
}
