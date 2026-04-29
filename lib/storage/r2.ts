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
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see AGENTS.md §7)`);
  return v;
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: "auto", // R2 ignores region but requires the field
    endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
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
