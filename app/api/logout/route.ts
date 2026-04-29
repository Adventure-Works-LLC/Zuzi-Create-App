/**
 * POST /api/logout — clear the session cookie. Always returns 204.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const session = await getSession();
  session.destroy();
  return new NextResponse(null, { status: 204 });
}
