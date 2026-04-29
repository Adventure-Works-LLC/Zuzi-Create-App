/**
 * Session via iron-session — sealed httpOnly cookie. 30-day rolling Max-Age.
 *
 * iron-session uses node:crypto under the hood; route handlers that import this MUST
 * declare `export const runtime = 'nodejs'` (see AGENTS.md §2). Middleware does NOT
 * import this module — it only checks cookie presence so it can stay Edge-compatible.
 */

import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface ZuziSession {
  authedAt?: number;
}

const COOKIE_NAME = "zuzi_session";

function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error(
      "SESSION_SECRET env var is missing or shorter than 32 chars (iron-session requirement)",
    );
  }
  return {
    cookieName: COOKIE_NAME,
    password,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
  };
}

export async function getSession(): Promise<IronSession<ZuziSession>> {
  // Next 16 cookies() returns a Promise.
  const cookieStore = await cookies();
  return getIronSession<ZuziSession>(cookieStore, sessionOptions());
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
