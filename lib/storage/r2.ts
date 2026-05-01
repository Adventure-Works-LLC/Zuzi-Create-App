/**
 * Cloudflare R2 client (S3-compatible) — PRIVATE bucket.
 *
 * `zuzi-images` is a private bucket. There is NO public URL. All image access goes
 * through `signedUrlFor(key, ttl)` which returns a presigned URL valid for `ttl`
 * seconds (default 1 hour). See AGENTS.md §7 for the full privacy / threat model.
 *
 * Endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
 *
 * Env vars (see AGENTS.md §7):
 *   R2_ACCOUNT_ID    Cloudflare account id
 *   R2_ACCESS_KEY    R2 access key id
 *   R2_SECRET_KEY    R2 secret access key
 *   R2_BUCKET        bucket name (zuzi-images)
 *
 * Native module note: @aws-sdk/client-s3 + s3-request-presigner use Node-only deps.
 * Any Route Handler / Proxy / instrumentation file that imports this MUST declare
 * `export const runtime = 'nodejs'` per AGENTS.md §2.
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Read an R2 env var and validate its shape.
 *
 * Railway dashboard pastes commonly include trailing newlines or surrounding
 * whitespace, which silently produce malformed TLS SNI hostnames (e.g.
 * `<account>\n.r2.cloudflarestorage.com`) that Cloudflare rejects with TLS alert 40
 * (handshake_failure). This is the SAME class of bug as the bcrypt-hash dotenv-expand
 * mangling we already documented in AGENTS.md §7 — paste hygiene matters.
 *
 * `requireEnv` trims whitespace, warns when it had to, and validates basic shape
 * for known-format vars (R2_ACCOUNT_ID = 32 hex chars).
 */
function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required (see AGENTS.md §7)`);
  const trimmed = raw.trim();
  if (trimmed !== raw) {
    console.warn(
      `[r2] ${name} had surrounding whitespace/newlines; trimmed (raw len=${raw.length}, trimmed len=${trimmed.length})`,
    );
  }
  if (trimmed.length === 0) {
    throw new Error(`${name} is empty after trim`);
  }
  // Specific shape checks for the env vars where format is well-defined.
  if (name === "R2_ACCOUNT_ID" && !/^[0-9a-f]{32}$/i.test(trimmed)) {
    throw new Error(
      `R2_ACCOUNT_ID must be 32 hex chars, got ${trimmed.length} chars; check Railway dashboard for stray characters`,
    );
  }
  return trimmed;
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  _client = new S3Client({
    region: "auto", // R2 ignores region but requires the field
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY"),
      secretAccessKey: requireEnv("R2_SECRET_KEY"),
    },
  });
  return _client;
}

const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
      Body: bytes,
      ContentType: contentType,
      // Cache-Control is a CDN/browser cache hint, NOT bucket access control.
      // Private bucket + immutable cache is fine — clients can re-fetch with a
      // valid signed URL when needed.
      CacheControl: CACHE_CONTROL,
    }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const resp = await client().send(
    new GetObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
    }),
  );
  if (!resp.Body) throw new Error(`R2 getObject: empty body for ${key}`);
  const bytes = await resp.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * HEAD an R2 object — returns true if it exists, false on 404. Other
 * S3 errors (auth, network, etc.) are re-thrown so callers can decide
 * how to handle them (retry, fail loudly, etc.). Used by the stuck-
 * iteration boot recovery path: the worker writes R2 BEFORE updating
 * the DB, so an iteration whose tile rows are still `pending` may
 * actually have completed-and-uploaded outputs in R2 from a worker
 * that died after the upload but before the DB write. HEAD lets us
 * detect that state without paying the GetObject bandwidth.
 *
 * R2 semantics: a missing key returns 404 (NoSuchKey or NotFound).
 * Some SDK builds raise an error with `name === 'NotFound'`, others
 * with `$metadata.httpStatusCode === 404`. We accept both shapes.
 */
export async function headObject(key: string): Promise<boolean> {
  try {
    await client().send(
      new HeadObjectCommand({
        Bucket: requireEnv("R2_BUCKET"),
        Key: key,
      }),
    );
    return true;
  } catch (e) {
    const name = (e as { name?: string }).name;
    const status = (e as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
      return false;
    }
    throw e;
  }
}

/**
 * Delete a single object from R2. Idempotent — deleting a non-existent
 * key succeeds (S3-compat semantics; R2 returns 204 either way). Caller
 * is responsible for prefix validation (only `inputs/`, `outputs/`,
 * `thumbs/` should ever be deleted via this path).
 */
export async function deleteObject(key: string): Promise<void> {
  await client().send(
    new DeleteObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
    }),
  );
}

/**
 * Batch-delete up to 1000 objects in a single S3 DeleteObjects call. Used
 * by the source-hard-delete path: a source's R2 footprint is its
 * input image + every output_image_key + every thumb_image_key for tiles
 * across all of its iterations. A typical Zuzi source with 5–10 generations
 * × 3 tiles each + thumbs lands around 30–60 keys; well under the batch
 * cap.
 *
 * The S3 API caps batch size at 1000; we chunk above that defensively
 * even though Zuzi's footprint will never come close.
 *
 * Returns nothing — callers that need per-key success state should fall
 * back to single-shot `deleteObject` calls. The hard-delete path treats
 * R2 cleanup as best-effort (we log + continue on failure rather than
 * blocking the DB delete) since orphan R2 objects are recoverable via a
 * future sweep job; the user-facing "delete forever" promise is about
 * the row leaving the UI, not perfect storage hygiene.
 */
export async function deleteObjects(keys: ReadonlyArray<string>): Promise<void> {
  if (keys.length === 0) return;
  const bucket = requireEnv("R2_BUCKET");
  const BATCH_SIZE = 1000;
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const chunk = keys.slice(i, i + BATCH_SIZE);
    await client().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          // Quiet mode: the response omits successfully-deleted keys, only
          // returning failures. We don't surface failures per-key today
          // (best-effort cleanup) so quiet=true reduces response size.
          Quiet: true,
        },
      }),
    );
  }
}

/**
 * Returns a presigned GET URL for the object at `key`, valid for `ttlSeconds`.
 * Default 1 hour. Caller is responsible for checking auth before issuing — the URL
 * itself is bearer-style and works without a session for its TTL.
 *
 * Path-traversal defense lives at the route layer (validate the key prefix before
 * calling this), not here.
 */
export async function signedUrlFor(
  key: string,
  ttlSeconds = 3600,
): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
    }),
    { expiresIn: ttlSeconds },
  );
}
