"use client";

/**
 * /logout — recovery page for stuck-session scenarios + general sign-out.
 *
 * Renders a small "Signing out…" UI, POSTs `/api/logout` on mount to clear
 * the httpOnly session cookie, then redirects to /login.
 *
 * Three callers:
 *   1. The "Sign out" affordance at the page level (app/(app)/page.tsx).
 *   2. The `authFetch` 401 auto-recovery path — any client-side fetch to
 *      `/api/*` that returns 401 navigates here with `?next` + `?reason`
 *      preserved so the user lands on /login with the correct context
 *      and returns to where they were after sign-in.
 *   3. Direct URL entry — `/logout` works as a manual recovery URL.
 *
 * Query-param forwarding (NEW): preserves `?next=…` and `?reason=…` and
 * passes them through to /login so the post-login redirect lands on the
 * right page AND /login can show context (e.g. "session expired"). Both
 * are sanitised — next must be a same-origin path, reason must be
 * known.
 *
 * Proxy lets this page through for the case of an already-logged-out
 * user navigating here: proxy.ts redirects to /login when no cookie,
 * which would mean /api/logout is never even called; that's fine —
 * there's nothing to log out of.
 */

import { useEffect } from "react";

/** Sanitise the next-path query param. Must be a same-origin path
 *  (`/…`), must not be a protocol-relative URL (`//…`). Anything else
 *  collapses to `/`. Mirrors the safeNextPath() helper in /login. */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

/** Only known reasons are forwarded. Anything else is dropped so we
 *  don't reflect arbitrary query strings into /login's render path. */
const KNOWN_REASONS = new Set(["expired"]);
function safeReason(raw: string | null): string | null {
  if (raw && KNOWN_REASONS.has(raw)) return raw;
  return null;
}

export default function LogoutPage() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch {
        // Network failure → still redirect; worst case the user lands on
        // /login with a stale cookie and the next manual login replaces it.
      }
      if (cancelled) return;
      if (typeof window === "undefined") return;

      const incoming = new URLSearchParams(window.location.search);
      const next = safeNext(incoming.get("next"));
      const reason = safeReason(incoming.get("reason"));

      const out = new URLSearchParams();
      // Only set next when it's not the trivial default — keeps /login's
      // URL tidy in the common manual-signout case.
      if (next !== "/") out.set("next", next);
      if (reason) out.set("reason", reason);

      const qs = out.toString();
      const url = qs ? `/login?${qs}` : "/login";

      // Use window.location.replace so the back button doesn't bring the
      // user back here (and re-trigger another POST /api/logout).
      window.location.replace(url);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FAF7F2",
        color: "#7A7368",
        fontFamily:
          "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: "15px",
      }}
    >
      Signing out…
    </div>
  );
}
