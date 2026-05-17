"use client";

/**
 * /logout — recovery page for stuck-session scenarios.
 *
 * Renders a small "Signing out…" UI, POSTs `/api/logout` on mount to clear
 * the httpOnly session cookie, then redirects to /login.
 *
 * Two callers:
 *   1. The "Sign out" affordance in the SourceStrip header.
 *   2. Direct URL entry — `/logout` is the recovery URL Zuzi can navigate
 *      to manually when something has gone wrong with her session (e.g.,
 *      she sees empty data + a "couldn't authenticate" message because her
 *      cookie unsealed-but-expired-via-iron-session-ttl). The page works
 *      whether or not the cookie is valid — `POST /api/logout` always
 *      returns 204 regardless.
 *
 * Proxy lets this page through for the (rare) case of an already-logged-out
 * user navigating here directly: proxy.ts only redirects unauthenticated
 * users to /login, and after /api/logout the next request finds no cookie
 * → redirects to /login automatically. So either way the user lands on
 * /login after this page does its work.
 */

import { useEffect } from "react";

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
      // Use window.location.replace so the back button doesn't bring the
      // user back here (and re-trigger another POST /api/logout). replace()
      // removes /logout from the browser history.
      if (typeof window !== "undefined") {
        window.location.replace("/login");
      }
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
