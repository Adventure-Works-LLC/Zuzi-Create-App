/**
 * POST /api/upload
 *
 * Body: multipart/form-data with a single `file` field.
 *
 * Pipeline:
 *   1. Auth: getSession() wrapped in try/catch — unsealable cookies → 401 (this is the
 *      Prompt-1 deferred concern, now reachable so handled here).
 *   2. Sharp: rotate() (EXIF) → resize(2048, 2048, fit:'inside', withoutEnlargement) →
 *      jpeg(q85). Read width/height from the RESIZED buffer (not the source) so the
 *      returned aspect ratio reflects what'll be sent to Gemini.
 *   3. R2: putObject inputs/<ulid>.jpg with Cache-Control immutable.
 *   4. Compute snapped aspect ratio via nearestSupportedAspectRatio.
 *   5. Return { inputKey, w, h, aspectRatio, publicUrl }.
 *
 * runtime = 'nodejs' is required: sharp + @aws-sdk/client-s3 + iron-session all native.
 */

import { NextResponse } from "next/server";
import { ulid } from "ulid";
import sharp from "sharp";

import { getSession } from "@/lib/auth/session";
import { putObject, publicUrlFor } from "@/lib/storage/r2";
import { nearestSupportedAspectRatio } from "@/lib/gemini/aspectRatio";

export const runtime = "nodejs";

const MAX_RAW_BYTES = 30 * 1024 * 1024; // 30MB hard cap on uploaded source

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    // Forged / unsealable cookie — treat as unauthenticated (deferred from Prompt 1).
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "no_file" }, { status: 400 });
    }
    file = f;
  } catch {
    return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
  }

  if (file.size > MAX_RAW_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", maxBytes: MAX_RAW_BYTES, gotBytes: file.size },
      { status: 413 },
    );
  }

  const raw = Buffer.from(await file.arrayBuffer());

  let resized: Buffer;
  let width: number;
  let height: number;
  try {
    resized = await sharp(raw)
      .rotate()
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/heif|heic|libheif/i.test(message)) {
      return NextResponse.json(
        {
          error: "heic_unsupported",
          detail:
            "HEIC not supported on this server — convert to JPEG and re-upload.",
        },
        { status: 415 },
      );
    }
    return NextResponse.json(
      { error: "image_decode_failed", detail: message },
      { status: 400 },
    );
  }

  if (width <= 0 || height <= 0) {
    return NextResponse.json(
      { error: "invalid_dimensions", width, height },
      { status: 400 },
    );
  }

  const inputKey = `inputs/${ulid()}.jpg`;
  try {
    await putObject(inputKey, resized, "image/jpeg");
  } catch (e) {
    return NextResponse.json(
      {
        error: "r2_upload_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  const aspectRatio = nearestSupportedAspectRatio(width, height);

  return NextResponse.json(
    {
      inputKey,
      w: width,
      h: height,
      aspectRatio,
      publicUrl: publicUrlFor(inputKey),
    },
    { status: 200 },
  );
}
