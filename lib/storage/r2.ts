/**
 * Cloudflare R2 client (S3-compatible).
 *
 * Endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
 * Bucket:   $R2_BUCKET (e.g., zuzi-images)
 * Public:   https://$R2_PUBLIC_HOST (default pub-<hash>.r2.dev)
 *
 * Env vars (see AGENTS.md §7):
 *   R2_ACCOUNT_ID    Cloudflare account id
 *   R2_ACCESS_KEY    R2 access key id
 *   R2_SECRET_KEY    R2 secret access key
 *   R2_BUCKET        bucket name (zuzi-images)
 *   R2_PUBLIC_HOST   public hostname only, no protocol or trailing slash
 *                    (e.g. pub-00ea5347e7c44125bbf6d96839b774b7.r2.dev)
 *
 * Native module note: @aws-sdk/client-s3 uses Node-only deps. Any Route Handler /
 * Proxy / instrumentation file that imports this MUST declare
 * `export const runtime = 'nodejs'` per AGENTS.md §2.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

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

export function publicUrlFor(key: string): string {
  const host = requireEnv("R2_PUBLIC_HOST");
  return `https://${host}/${key}`;
}
