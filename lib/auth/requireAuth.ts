/**
 * Centralised auth check for API routes — replaces the per-route
 * `isAuthed()` pattern that each route was copy/pasting.
 *
 * Two responsibilities:
 *
 *   1. Authenticate: read the iron-session cookie, return null if missing,
 *      malformed, unsealable, or `authedAt` is missing/zero. Catches the
 *      "cookie present but unsealable" case (wrong SESSION_SECRET, stale
 *      seal past ttl, etc.) — both surface as null here.
 *
 *   2. Roll the session forward — on every successful auth, call
 *      `session.save()`. iron-session bakes the issued-at timestamp into
 *      the seal AND writes a fresh Set-Cookie header with current
 *      `maxAge`. The combination means an active user (one who hits any
 *      authenticated API at least once per ttl window — 30 days as
 *      configured in `lib/auth/session.ts`) NEVER sees a silent
 *      session-expiry break. Their seal is continuously refreshed, the
 *      ttl never elapses.
 *
 *      The bug this prevents: Zuzi opens the app, gets the empty-data +
 *      "authentication failed" state. Root cause was iron-session's
 *      default 14-day ttl silently expiring her seal even though the
 *      cookie was still in her browser. The ttl bump (session.ts) fixed
 *      the absolute window; rolling refresh here makes sure she never
 *      lands in that window in the first place.
 *
 * Usage pattern (replaces the local `isAuthed()` in each route):
 *
 *   const session = await requireAuth();
 *   if (!session) {
 *     return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
 *   }
 *
 * Native module note: getSession transitively uses node:crypto via
 * iron-session, so any route importing this module MUST declare
 * `runtime = 'nodejs'` (AGENTS.md §2). All current API routes already do.
 */

import type { IronSession } from "iron-session";

import { getSession, type ZuziSession } from "./session";

export async function requireAuth(): Promise<IronSession<ZuziSession> | null> {
  let session: IronSession<ZuziSession>;
  try {
    session = await getSession();
  } catch {
    // Unsealable cookie (mangled, signed with rotated SESSION_SECRET,
    // past internal ttl, etc.). Returning null surfaces as 401 to the
    // client; the client's `authFetch` wrapper then redirects the user
    // through /logout (which clears the bad cookie) to /login.
    return null;
  }

  if (typeof session.authedAt !== "number" || session.authedAt <= 0) {
    return null;
  }

  // Rolling refresh — extend the session for another full ttl window.
  // session.save() writes a fresh Set-Cookie header on the outgoing
  // response. The save MUST complete before the route handler returns
  // its response (the header is finalised then), so this is awaited.
  // If the save fails for any reason, fall through and let the route
  // succeed anyway — losing one refresh tick is better than 500ing a
  // valid request. The next request that succeeds will refresh.
  try {
    await session.save();
  } catch {
    /* best-effort; one missed refresh is harmless */
  }

  return session;
}
