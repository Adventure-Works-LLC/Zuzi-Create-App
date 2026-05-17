"use client";

/**
 * authFetch — client-side fetch wrapper that auto-recovers from a 401.
 *
 * Drop-in replacement for `fetch()` in any code path that hits an
 * authenticated `/api/*` endpoint. On a 401 response:
 *
 *   1. Compute the user's current location (for return-after-login).
 *   2. `window.location.replace('/logout?next=…&reason=expired')` —
 *      `/logout` POSTs `/api/logout` (which clears the httpOnly session
 *      cookie via Set-Cookie max-age=0), then forwards to `/login` with
 *      the next + reason params preserved. `/login` shows a "session
 *      expired" notice and, after successful login, returns the user to
 *      where they were.
 *   3. Throws so the caller's error path runs synchronously — but the
 *      navigation has already started, so the error UI is never visible
 *      (the page is about to unmount).
 *
 * Why /logout and not /login directly: the bad cookie is httpOnly, so
 * the client can't clear it without a server-side endpoint. If we just
 * navigated to /login with the bad cookie still in the jar, the
 * proxy.ts auth gate (which only checks presence, not validity) would
 * see the cookie and bounce us back to / — infinite loop. /logout
 * clears it server-side via Set-Cookie, then /login's route is reachable.
 *
 * Use raw `fetch()` (not authFetch) for endpoints that intentionally
 * return 401 for non-session reasons:
 *   - `/api/login` returns 401 for "wrong password" (the login form
 *     surfaces it as an inline error; redirecting to /logout would be
 *     absurd — we're already on /login).
 *   - `/api/logout` always returns 204 — no 401 possible.
 *
 * Server-side rendering: `typeof window === "undefined"` guards the
 * redirect so this is safe to import from `"use client"` modules that
 * may briefly run on the server during hydration.
 */

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const resp = await fetch(input, init);
  if (resp.status === 401 && typeof window !== "undefined") {
    // Preserve where the user was — sanitised to same-origin paths only
    // (mirrors safeNextPath() in /login).
    const here = window.location.pathname + window.location.search;
    const safeNext = here.startsWith("/") && !here.startsWith("//") ? here : "/";
    const params = new URLSearchParams({
      next: safeNext,
      reason: "expired",
    });
    window.location.replace(`/logout?${params.toString()}`);
    // Throw to short-circuit the caller's success path while navigation
    // happens. The throw message doesn't reach the user — the page is
    // about to unload.
    throw new Error("session_expired");
  }
  return resp;
}
