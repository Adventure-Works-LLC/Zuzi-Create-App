/**
 * (feed) route group — v7 Zuzi's Scroll, the home page (AGENTS.md §18).
 * Its own look (gallery wall, light/dark with the device) and faces; the
 * Studio keeps the (app) group's dark theme at /studio.
 *
 * Cookie-protected by proxy.ts like every page; the API routes also check
 * the session.
 */

import { Bricolage_Grotesque, Literata } from "next/font/google";

import "./feed.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--zs-display",
  display: "swap",
});

const label = Literata({
  subsets: ["latin"],
  variable: "--zs-label",
  style: ["normal", "italic"],
  display: "swap",
});

export default function FeedLayout({ children }: { children: React.ReactNode }) {
  return <div className={`zs-root ${display.variable} ${label.variable}`}>{children}</div>;
}
