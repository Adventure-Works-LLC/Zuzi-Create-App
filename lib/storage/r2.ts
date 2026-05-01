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
 * Best-effort delete of a single object. R2's S3-compatible API treats
 * deleting a non-existent key as a success (idempotent). Caller is
 * responsible for auth + key-prefix validation; we just issue the call.
 *
 * Throws on transport / auth errors. Wrap in try/catch + log if you want
 * "best-effort cleanup that doesn't roll back the user-visible action."
 * The hard-delete-source path uses that pattern: DB delete in a
 * transaction first, then R2 cleanup; orphaned R2 objects (rare:
 * transient network blip during cleanup) sit until a future sweep job.
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
 * Batched delete (up to 1000 keys per call per S3 spec). The hard-delete-
 * source path can produce dozens of keys per source (input + outputs +
 * thumbs across all iterations); batching keeps Railway-side latency
 * down + Cloudflare-side request count low.
 *
 * Returns the per-key error list from R2's response (empty on full
 * success). Caller decides whether partial failure rolls back or just
 * logs orphans.
 */
export async function deleteObjects(
  keys: ReadonlyArray<string>,
): Promise<Array<{ key: string; message: string }>> {
  if (keys.length === 0) return [];
  const resp = await client().send(
    new DeleteObjectsCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Delete: {
        Objects: keys.map((k) => ({ Key: k })),
        Quiet: true, // suppresses per-key success entries; Errors[] still populated
      },
    }),
  );
  return (resp.Errors ?? []).map((e) => ({
    key: e.Key ?? "<unknown>",
    message: e.Message ?? "<unknown>",
  }));
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
