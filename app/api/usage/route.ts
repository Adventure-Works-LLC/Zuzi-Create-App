/**
 * GET /api/usage — spend + quota gauges for the Studio.
 *
 * Response:
 *   {
 *     monthUsd,           // usage_log sum for the current UTC month
 *     capUsd,             // MONTHLY_USD_CAP (app-level $ cap)
 *     proToday: {
 *       count,            // ~Gemini Pro image requests since midnight UTC
 *       limit,            // Google's per-day request quota for the Pro
 *                         // image model (env GEMINI_PRO_DAILY_QUOTA,
 *                         // default 250 — update the env var when the
 *                         // quota-increase request is granted)
 *       resetAt,          // unix ms of the next midnight UTC (observed
 *                         // reset boundary for Google's daily metric)
 *     }
 *   }
 *
 * The Pro count is approximate (see proRequestsSince in
 * lib/db/queries.ts) — the InputBar renders it with a "~".
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import {
  monthlyUsageUsd,
  proImagesLoggedSince,
  proRequestsSince,
} from "@/lib/db/queries";

export const runtime = "nodejs";

// Same NaN-guarded env parsing rationale as MONTHLY_USD_CAP in
// app/api/iterate/route.ts — a fat-fingered Railway value must not
// silently break the gauge.
const _quotaParsed = Number(process.env.GEMINI_PRO_DAILY_QUOTA ?? "250");
const PRO_DAILY_QUOTA =
  Number.isFinite(_quotaParsed) && _quotaParsed > 0 ? _quotaParsed : 250;
// Default 250 — KEEP IN LOCKSTEP with app/api/iterate/route.ts.
const _capParsed = Number(process.env.MONTHLY_USD_CAP ?? "250");
const MONTHLY_USD_CAP =
  Number.isFinite(_capParsed) && _capParsed > 0 ? _capParsed : 250;

export async function GET(): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const now = new Date();
  const dayStartUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return NextResponse.json(
    {
      monthUsd: monthlyUsageUsd(),
      capUsd: MONTHLY_USD_CAP,
      proToday: {
        // MAX of two counters (see queries.ts comments): the tile walk
        // sees in-flight/just-finished runs before their usage_log row
        // exists; the usage_log sum survives Zuzi's hard-deletes. Each
        // covers the other's blind spot; MAX is never an overcount
        // beyond double-attribution of the same completed run, which
        // both sides value identically.
        count: Math.max(
          proRequestsSince(dayStartUtc),
          proImagesLoggedSince(dayStartUtc),
        ),
        limit: PRO_DAILY_QUOTA,
        resetAt: dayStartUtc + 24 * 60 * 60 * 1000,
      },
    },
    { status: 200 },
  );
}
