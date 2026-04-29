/**
 * Auth gate (Next.js 16 Proxy — formerly middleware; renamed in Next 16, see
 * https://nextjs.org/docs/messages/middleware-to-proxy).
 *
 * Edge-compatible: only checks cookie PRESENCE, not signature. The actual session
 * sealing/unsealing happens in route handlers and pages (which run on Node and import
 * `lib/auth/session.ts`). A missing or empty cookie redirects pages to /login or
 * returns 401 for /api/* requests; a present cookie passes through. Forged cookies that
 * survive this gate get rejected downstream when iron-session tries to unseal them —
 * the route handlers treat unsealable cookies as unauthenticated.
 *
 * This split lets the proxy stay on the Edge runtime (no node:crypto in scope) while
 * still gating every protected request.
 */

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "zuzi_session";

export function proxy(req: NextRequest): NextResponse {
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const path = req.nextUrl.pathname;
  const isLoginPage = path === "/login";
  const isApi = path.startsWith("/api/");
  const hasSession = typeof session === "string" && session.length > 0;

  if (!hasSession && !isLoginPage) {
    // API requests get a clean 401 (their callers handle it); page requests redirect.
    if (isApi) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (hasSession && isLoginPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Run on every request EXCEPT API auth endpoints (which manage their own state),
// Next.js internals, static assets, and the favicon/manifest/icons used by the login
// shell.
export const config = {
  matcher: [
    "/((?!api/login|api/logout|_next/|favicon|manifest\\.webmanifest|icon-|apple-touch-icon|apple-splash|sw\\.js).*)",
  ],
};
