/**
 * POST /api/login
 *
 * Body: { password: string } (JSON) or form-urlencoded `password=...` (form post).
 *
 * Flow: rate-limit check → bcrypt verify → set sealed httpOnly session cookie.
 *
 * Status codes:
 *   204 — success, session cookie set
 *   401 — wrong password (or missing); rate-limit attempt incremented
 *   429 — IP rate-limited; Retry-After header set
 *   500 — env config missing (ZUZI_PASSWORD_HASH or SESSION_SECRET)
 */

import { NextResponse } from "next/server";

import { verifyPassword } from "@/lib/auth/password";
import {
  checkLoginRateLimit,
  clearAttempts,
  recordFailedAttempt,
} from "@/lib/auth/rateLimit";
import { getSession } from "@/lib/auth/session";

// bcryptjs + iron-session use node:crypto; force the Node runtime.
export const runtime = "nodejs";

async function readPassword(req: Request): Promise<string | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = (await req.json()) as { password?: unknown };
      return typeof body.password === "string" ? body.password : null;
    } catch {
      return null;
    }
  }
  if (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  ) {
    try {
      const form = await req.formData();
      const v = form.get("password");
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const limit = checkLoginRateLimit(req);
  if (!limit.ok) {
    return new NextResponse(
      JSON.stringify({
        error: "rate_limited",
        retryAfterSec: limit.retryAfterSec,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(limit.retryAfterSec ?? 300),
        },
      },
    );
  }

  const password = await readPassword(req);
  if (!password) {
    recordFailedAttempt(req);
    return NextResponse.json({ error: "missing_password" }, { status: 401 });
  }

  let valid = false;
  try {
    valid = await verifyPassword(password);
  } catch (e) {
    return NextResponse.json(
      {
        error: "server_misconfigured",
        detail: e instanceof Error ? e.message : "unknown",
      },
      { status: 500 },
    );
  }

  if (!valid) {
    recordFailedAttempt(req);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  let session;
  try {
    session = await getSession();
  } catch (e) {
    return NextResponse.json(
      {
        error: "server_misconfigured",
        detail: e instanceof Error ? e.message : "unknown",
      },
      { status: 500 },
    );
  }

  session.authedAt = Date.now();
  await session.save();
  clearAttempts(req);

  return new NextResponse(null, { status: 204 });
}
