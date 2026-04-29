/**
 * POST /api/sources — multipart upload → sharp normalize → R2 → INSERT into sources.
 *  Returns { sourceId, inputKey, w, h, aspectRatio }.
 *
 * GET /api/sources?archived=false&limit=20 — source strip with iteration_count and
 *  favorite_count aggregates per source. Newest first. (`archived=true` would list the
 *  archived set; v1 only ships the active strip but the param is honored.)
 *
 * Auth required on both. runtime = 'nodejs' for sharp + better-sqlite3.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { ulid } from "ulid";

import { getSession } from "@/lib/auth/session";
import {
  insertSource,
  listActiveSourcesWithAggregates,
  listAllSources,
} from "@/lib/db/queries";
import { nearestSupportedAspectRatio } from "@/lib/gemini/aspectRatio";
import { putObject } from "@/lib/storage/r2";

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

export async function POST(req: Request): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

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

  let resized: Buffer;
  let width: number;
  let height: number;
  try {
    resized = await sharp(raw)
      .rotate()
      .resize(INPUT_LONG_EDGE_PX, INPUT_LONG_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: INPUT_JPEG_QUALITY })
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

  const sourceId = ulid();
  const inputKey = `inputs/${sourceId}.jpg`;
  const aspectRatio = nearestSupportedAspectRatio(width, height);

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

  // Insert AFTER R2 succeeds — no orphan DB rows pointing at missing R2 objects.
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

  return NextResponse.json(
    {
      sourceId,
      inputKey,
      w: width,
      h: height,
      aspectRatio,
    },
    { status: 201 },
  );
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
