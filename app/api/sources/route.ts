/**
 * POST /api/sources — TWO entry paths, same return shape:
 *
 *   1. multipart/form-data (file=<File>) — original upload path. Sharp
 *      normalize → R2 → INSERT into sources.
 *   2. application/json ({ promoteFromTileId: <ulid> }) — "Use as Source"
 *      from the Lightbox. Server-side promote-from-tile: read the tile's
 *      output_image_key, fetch bytes from R2 (private bucket, server-side,
 *      no expired-URL window the way a client roundtrip would have), run
 *      through the SAME sharp normalize pipeline, then R2 → INSERT into
 *      sources. Cheaper than the prior client fetch+upload roundtrip and
 *      avoids the 1h presigned-URL expiry footgun (an old lightbox open
 *      against a stale URL would silently 403 the fetch step).
 *
 *  Returns { sourceId, inputKey, w, h, aspectRatio } in both cases.
 *
 * GET /api/sources?archived=false&limit=20 — source strip with iteration_count and
 *  favorite_count aggregates per source. Newest first. (`archived=true` would list the
 *  archived set; v1 only ships the active strip but the param is honored.)
 *
 * Auth required on all paths. runtime = 'nodejs' for sharp + better-sqlite3.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { ulid } from "ulid";

import { getSession } from "@/lib/auth/session";
import {
  getTile,
  insertSource,
  listActiveSourcesWithAggregates,
  listAllSources,
} from "@/lib/db/queries";
import { nearestSupportedAspectRatio } from "@/lib/gemini/aspectRatio";
import { getObject, putObject } from "@/lib/storage/r2";

export const runtime = "nodejs";

const MAX_RAW_BYTES = 30 * 1024 * 1024;
const INPUT_LONG_EDGE_PX = 2048;
const INPUT_JPEG_QUALITY = 85;

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

/** Outcome shape from the shared "raw bytes → sharp normalize → R2 putObject
 *  + insertSource" tail. Both upload and promote-from-tile end here so every
 *  sources row in the DB has been through the same normalization pipeline. */
interface NormalizeAndInsertResult {
  sourceId: string;
  inputKey: string;
  w: number;
  h: number;
  aspectRatio: string;
}

/** Shared tail. Caller passes the raw bytes already in memory + the optional
 *  original filename. Throws on bad image / R2 failure; route-layer handlers
 *  translate to HTTP responses. */
async function normalizeAndInsert(
  raw: Buffer,
  originalFilename: string | null,
): Promise<NormalizeAndInsertResult> {
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
    throw new Error(`invalid dimensions after normalize: ${width}x${height}`);
  }

  const sourceId = ulid();
  const inputKey = `inputs/${sourceId}.jpg`;
  const aspectRatio = nearestSupportedAspectRatio(width, height);

  // R2 first; only insert DB row if R2 succeeds. No orphan rows pointing at
  // missing R2 objects.
  await putObject(inputKey, resized, "image/jpeg");
  insertSource({
    id: sourceId,
    input_image_key: inputKey,
    original_filename: originalFilename,
    w: width,
    h: height,
    aspect_ratio: aspectRatio,
    created_at: Date.now(),
    archived_at: null,
  });

  return { sourceId, inputKey, w: width, h: height, aspectRatio };
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Branch on content-type. Multipart → upload; JSON → promote-from-tile.
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handlePromoteFromTile(req);
  }
  return handleUpload(req);
}

async function handleUpload(req: Request): Promise<Response> {
  let file: File;
  let originalFilename: string | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "no_file" }, { status: 400 });
    }
    file = f;
    originalFilename = f.name && f.name !== "blob" ? f.name : null;
  } catch {
    return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
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
    const result = await normalizeAndInsert(raw, originalFilename);
    return NextResponse.json(result, { status: 201 });
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
    if (/invalid dimensions/i.test(message)) {
      return NextResponse.json(
        { error: "invalid_dimensions", detail: message },
        { status: 400 },
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

/**
 * Promote-from-tile: client sends `{ promoteFromTileId: <ulid> }` and we
 * server-side fetch the tile's output bytes from R2, run the same sharp
 * normalize, and create a new sources row. Used by the Lightbox's "Use as
 * Source" button.
 *
 * Why server-side instead of client fetch+upload:
 *   - The R2 bucket is PRIVATE. Client access goes through 1h presigned URLs
 *     issued by /api/image-url. If the lightbox has been open >1h, the
 *     cached signed URL has expired and the client fetch silently 403s.
 *     Server-side fetch via getObject(key) sidesteps the entire signed-URL
 *     dance.
 *   - Saves a client roundtrip (download + reupload of ~150–800kb).
 *   - Avoids re-encoding twice (output JPEG → blob → File → multipart →
 *     sharp). One re-encode, server-side.
 */
async function handlePromoteFromTile(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const tileId =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { promoteFromTileId?: unknown }).promoteFromTileId ===
      "string"
      ? (body as { promoteFromTileId: string }).promoteFromTileId
      : null;

  if (!tileId) {
    return NextResponse.json(
      { error: "missing_tile_id", detail: "expected { promoteFromTileId }" },
      { status: 400 },
    );
  }

  const tile = getTile(tileId);
  if (!tile) {
    return NextResponse.json(
      { error: "tile_not_found", detail: `no tile with id ${tileId}` },
      { status: 404 },
    );
  }
  if (tile.status !== "done") {
    return NextResponse.json(
      {
        error: "tile_not_done",
        detail: `tile status is ${tile.status}; only done tiles are promotable`,
      },
      { status: 400 },
    );
  }
  if (!tile.output_image_key) {
    return NextResponse.json(
      {
        error: "tile_no_output",
        detail: "tile has no output_image_key (worker race?)",
      },
      { status: 400 },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await getObject(tile.output_image_key);
  } catch (e) {
    return NextResponse.json(
      {
        error: "r2_read_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  if (bytes.byteLength > MAX_RAW_BYTES) {
    // Pro 4K outputs can be ~3–6MB JPEGs at q90; well under 30MB. This is a
    // belt-and-suspenders check against an unexpectedly huge object.
    return NextResponse.json(
      {
        error: "file_too_large",
        maxBytes: MAX_RAW_BYTES,
        gotBytes: bytes.byteLength,
      },
      { status: 413 },
    );
  }

  try {
    const result = await normalizeAndInsert(bytes, null);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "promote_failed", detail: message },
      { status: 500 },
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const archivedParam = url.searchParams.get("archived");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1),
    100,
  );

  if (archivedParam === "true") {
    // Archive view: list the archived rows without aggregates (cheaper).
    const all = listAllSources(200);
    const sources = all
      .filter((s) => s.archived_at !== null)
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        inputKey: s.input_image_key,
        originalFilename: s.original_filename,
        w: s.w,
        h: s.h,
        aspectRatio: s.aspect_ratio,
        createdAt: s.created_at,
        archivedAt: s.archived_at,
      }));
    return NextResponse.json({ sources }, { status: 200 });
  }

  const rows = listActiveSourcesWithAggregates(limit);
  return NextResponse.json(
    {
      sources: rows.map((r) => ({
        id: r.id,
        inputKey: r.input_image_key,
        originalFilename: r.original_filename,
        w: r.w,
        h: r.h,
        aspectRatio: r.aspect_ratio,
        createdAt: r.created_at,
        archivedAt: r.archived_at,
        iterationCount: Number(r.iteration_count),
        favoriteCount: Number(r.favorite_count),
      })),
    },
    { status: 200 },
  );
}
