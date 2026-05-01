/**
 * POST /api/iterations/:id/recover — manually trigger recovery for one
 * iteration.
 *
 * Same logic as the boot-time `recoverStuckIterations` sweep, scoped
 * to one iteration. Useful when the server is up but a particular
 * iteration is still stuck — e.g., user navigates back to a source
 * after some time and finds an old pending iteration the boot sweep
 * already ran on but happened to fail (transient R2 outage at boot,
 * tile bytes uploaded after boot but before user's revisit, etc.).
 *
 * Idempotent: calling on an already-terminal iteration returns
 * `outcome: "skipped"` with the existing status. The user-facing
 * "Try to recover" button surfaces this as a no-op visually (the
 * iteration's UI just refreshes with the same state).
 *
 * Returns the recovery outcome + final iteration status so the
 * client can update its store directly without a separate refetch.
 *
 * Auth required. runtime = 'nodejs'.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { recoverOneIteration } from "@/lib/stuckRecovery";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const result = await recoverOneIteration(id);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      {
        error: "recovery_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
