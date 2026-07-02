/**
 * POST /api/style-paintings — multipart/form-data (file=<File>,
 * artist?=<string>) upload of one painting into Zuzi's reference
 * library. Sharp normalize (2048px long-edge JPEG q85, mirrors the
 * sources pipeline) → R2 put at `styles/<style_id>.jpg` → INSERT into
 * `style_paintings`. Returns the full client row shape (id, inputKey,
 * metadata fields, dims). The optional `artist` form field (v4.0)
 * batch-tags uploads for the StylesPanel's artist filter — the client
 * prompts once per multi-file batch and stamps every file's POST.
 *
 * For multi-file uploads the client fires N parallel POSTs (one per
 * file). That keeps this route minimal and lets the existing
 * `requireAuth` + body-parsing path stay identical to /api/sources.
 *
 * Why NOT a promote-from-tile branch (like /api/sources has): style
 * paintings come from her external library (Sargent, Sorolla, …), not
 * from generated tiles. The semantic distinction matters — a tile is an
 * output of her own process; a style painting is a reference she
 * loves. Promoting a tile into the style library would conflate the
 * two and muddy the "show me my sketch in the style of THIS reference"
 * mental model.
 *
 * Aspect ratio is still computed + stored on the row even though style
 * paintings are SECONDARY inputs in style_explore mode (the SKETCH's
 * snapped aspect drives the call per AGENTS.md §3). Recording it gives
 * the StylesPanel a stable container size + leaves the door open for
 * a future "filter by aspect" filter without a follow-up migration.
 *
 * GET /api/style-paintings?archived=false&limit=200 — list newest first.
 * No aggregates (style paintings don't have iterations / tiles
 * directly), so the response is just the flat row shape. ExploreSheet
 * client-side shuffles its copy for variety.
 *
 * Auth required on both paths. runtime = 'nodejs' for sharp +
 * better-sqlite3.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { ulid } from "ulid";

import { requireAuth } from "@/lib/auth/requireAuth";
import {
  insertStylePainting,
  listStylePaintings,
} from "@/lib/db/queries";
import { nearestSupportedAspectRatio } from "@/lib/gemini/aspectRatio";
import { putObject } from "@/lib/storage/r2";

export const runtime = "nodejs";

const MAX_RAW_BYTES = 30 * 1024 * 1024;
const INPUT_LONG_EDGE_PX = 2048;
const INPUT_JPEG_QUALITY = 85;

export async function POST(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let file: File;
  let originalFilename: string | null = null;
  let artist: string | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "no_file" }, { status: 400 });
    }
    file = f;
    originalFilename = f.name && f.name !== "blob" ? f.name : null;
    // v4.0: optional batch artist tag. Trimmed; empty → null; length-
    // capped defensively (same 200-char ceiling a PATCH could set via
    // updateStylePaintingMetadata — nothing in the UI produces longer).
    const artistRaw = form.get("artist");
    if (typeof artistRaw === "string" && artistRaw.trim().length > 0) {
      artist = artistRaw.trim().slice(0, 200);
    }
  } catch (e) {
    // v4.5: surface the parse failure's cause. "invalid_multipart"
    // alone was undiagnosable in the field — truncated bodies (iPad
    // Safari under connection pressure), aborted requests, and
    // malformed boundaries all looked identical.
    return NextResponse.json(
      {
        error: "invalid_multipart",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 400 },
    );
  }

  if (file.size > MAX_RAW_BYTES) {
    return NextResponse.json(
      {
        error: "file_too_large",
        maxBytes: MAX_RAW_BYTES,
        gotBytes: file.size,
      },
      { status: 413 },
    );
  }

  const raw = Buffer.from(await file.arrayBuffer());

  try {
    const resized = await sharp(raw)
      .rotate()
      .resize(INPUT_LONG_EDGE_PX, INPUT_LONG_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: INPUT_JPEG_QUALITY })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    if (width <= 0 || height <= 0) {
      return NextResponse.json(
        {
          error: "invalid_dimensions",
          detail: `invalid dimensions after normalize: ${width}x${height}`,
        },
        { status: 400 },
      );
    }

    const id = ulid();
    const inputKey = `styles/${id}.jpg`;
    const aspectRatio = nearestSupportedAspectRatio(width, height);
    const createdAt = Date.now();

    // R2 first; only insert DB row if R2 succeeds. No orphan rows
    // pointing at missing R2 objects.
    await putObject(inputKey, resized, "image/jpeg");
    insertStylePainting({
      id,
      input_image_key: inputKey,
      original_filename: originalFilename,
      w: width,
      h: height,
      aspect_ratio: aspectRatio,
      title: null,
      artist,
      note: null,
      tag: null,
      created_at: createdAt,
      archived_at: null,
    });

    // Full client row shape — the hook's rowToStylePainting maps this
    // response directly into the store, so every field the GET list
    // returns must be present here too (missing keys would land as
    // `undefined` and diverge from a refetched row's `null`).
    return NextResponse.json(
      {
        id,
        inputKey,
        originalFilename,
        w: width,
        h: height,
        aspectRatio,
        title: null,
        artist,
        note: null,
        tag: null,
        createdAt,
        archivedAt: null,
      },
      { status: 201 },
    );
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
    if (/^The specified key does not exist|NoSuchKey|R2|s3/i.test(message)) {
      return NextResponse.json(
        { error: "r2_upload_failed", detail: message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "image_decode_failed", detail: message },
      { status: 400 },
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const archivedParam = url.searchParams.get("archived");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "200", 10) || 200, 1),
    500,
  );
  const archived = archivedParam === "true";

  const rows = listStylePaintings({ archived, limit });
  return NextResponse.json(
    {
      stylePaintings: rows.map((r) => ({
        id: r.id,
        inputKey: r.input_image_key,
        originalFilename: r.original_filename,
        w: r.w,
        h: r.h,
        aspectRatio: r.aspect_ratio,
        title: r.title,
        artist: r.artist,
        note: r.note,
        tag: r.tag,
        createdAt: r.created_at,
        archivedAt: r.archived_at,
      })),
    },
    { status: 200 },
  );
}
