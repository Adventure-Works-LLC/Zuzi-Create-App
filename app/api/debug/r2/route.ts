/**
 * GET /api/debug/r2 — diagnostic endpoint, NOT for production traffic.
 *
 * Reports R2 env var SHAPES (lengths only, never values), the constructed endpoint
 * URL, and whether a basic TLS handshake against the endpoint succeeds. Auth-gated.
 *
 * This exists to debug TLS-handshake-failure errors on Railway where the OpenSSL error
 * message is opaque. After upload works in production, this route can be deleted.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

interface EnvShape {
  present: boolean;
  raw_len: number;
  trimmed_len: number;
  trim_diff: number; // raw_len - trimmed_len; non-zero = whitespace was present
  prefix4: string;
  matches_hex32?: boolean;
}

function inspect(name: string): EnvShape {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      present: false,
      raw_len: 0,
      trimmed_len: 0,
      trim_diff: 0,
      prefix4: "",
    };
  }
  const trimmed = raw.trim();
  return {
    present: true,
    raw_len: raw.length,
    trimmed_len: trimmed.length,
    trim_diff: raw.length - trimmed.length,
    prefix4: trimmed.slice(0, 4),
    matches_hex32: /^[0-9a-f]{32}$/i.test(trimmed),
  };
}

export async function GET(): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const accountId = inspect("R2_ACCOUNT_ID");
  const accessKey = inspect("R2_ACCESS_KEY");
  const secretKey = inspect("R2_SECRET_KEY");
  const bucket = inspect("R2_BUCKET");

  const trimmedAccountId = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const endpoint = trimmedAccountId
    ? `https://${trimmedAccountId}.r2.cloudflarestorage.com`
    : null;

  // Try a basic HTTPS HEAD against the endpoint to surface TLS issues without
  // doing any real S3 op (which would also fail credential auth on Cloudflare's side
  // and complicate the diagnosis).
  let tlsTest: { ok: boolean; status?: number; error?: string } = {
    ok: false,
    error: "skipped (no endpoint)",
  };
  if (endpoint) {
    try {
      const resp = await fetch(endpoint, {
        method: "HEAD",
        // Short timeout to fail fast on TLS issues.
        signal: AbortSignal.timeout(8000),
      });
      tlsTest = { ok: true, status: resp.status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tlsTest = { ok: false, error: msg.slice(0, 400) };
    }
  }

  return NextResponse.json(
    {
      env: {
        R2_ACCOUNT_ID: accountId,
        R2_ACCESS_KEY: accessKey,
        R2_SECRET_KEY: secretKey,
        R2_BUCKET: bucket,
      },
      endpoint,
      tlsTest,
      node_version: process.version,
      runtime: process.env.NEXT_RUNTIME ?? "(unset)",
    },
    { status: 200 },
  );
}
