/**
 * v7 Zuzi's Scroll — feed_cards reads and writes (AGENTS.md §18).
 * Node runtime only (better-sqlite3 via lib/db/client).
 */

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { feed_cards, type FeedCard, type NewFeedCard } from "@/lib/db/schema";

export type FeedName = "invented" | "museum";

export function isFeedName(v: unknown): v is FeedName {
  return v === "invented" || v === "museum";
}

export function countReadyUnserved(feed: FeedName): number {
  const r = db()
    .select({ n: sql<number>`COUNT(*)` })
    .from(feed_cards)
    .where(and(eq(feed_cards.feed, feed), eq(feed_cards.status, "ready"), isNull(feed_cards.served_at)))
    .get();
  return r?.n ?? 0;
}

export function countPending(feed?: FeedName): number {
  const r = db()
    .select({ n: sql<number>`COUNT(*)` })
    .from(feed_cards)
    .where(feed ? and(eq(feed_cards.status, "pending"), eq(feed_cards.feed, feed)) : eq(feed_cards.status, "pending"))
    .get();
  return r?.n ?? 0;
}

/** Cards the producer started since `since` (ms) — the daily budget counter. Seeds don't count. */
export function countStartedSince(since: number): number {
  const r = db()
    .select({ n: sql<number>`COUNT(*)` })
    .from(feed_cards)
    .where(and(gte(feed_cards.created_at, since), sql`${feed_cards.id} NOT LIKE 'seed-%'`))
    .get();
  return r?.n ?? 0;
}

export function insertCard(row: NewFeedCard): void {
  db().insert(feed_cards).values(row).run();
}

export function insertCardIfAbsent(row: NewFeedCard): boolean {
  const r = db().insert(feed_cards).values(row).onConflictDoNothing().run();
  return r.changes > 0;
}

export function updateCard(id: string, patch: Partial<NewFeedCard>): void {
  db().update(feed_cards).set(patch).where(eq(feed_cards.id, id)).run();
}

export function addCost(id: string, usd: number): void {
  db()
    .update(feed_cards)
    .set({ cost_usd: sql`${feed_cards.cost_usd} + ${usd}` })
    .where(eq(feed_cards.id, id))
    .run();
}

export function getCard(id: string): FeedCard | undefined {
  return db().select().from(feed_cards).where(eq(feed_cards.id, id)).get();
}

/** Newest-first page of ready cards; `before` is a ready_at cursor. */
export function listReady(feed: FeedName, limit: number, before?: number): FeedCard[] {
  const conds = [eq(feed_cards.feed, feed), eq(feed_cards.status, "ready")];
  if (typeof before === "number") conds.push(lt(feed_cards.ready_at, before));
  return db().select().from(feed_cards).where(and(...conds)).orderBy(desc(feed_cards.ready_at)).limit(limit).all();
}

/** Cards that became ready after `since` (oldest first) — appended live at the bottom. */
export function listReadySince(feed: FeedName, since: number, limit: number): FeedCard[] {
  return db()
    .select()
    .from(feed_cards)
    .where(and(eq(feed_cards.feed, feed), eq(feed_cards.status, "ready"), gt(feed_cards.ready_at, since)))
    .orderBy(asc(feed_cards.ready_at))
    .limit(limit)
    .all();
}

export function listSaved(limit: number, before?: number): FeedCard[] {
  const conds = [eq(feed_cards.status, "ready"), sql`${feed_cards.saved_at} IS NOT NULL`];
  if (typeof before === "number") conds.push(lt(feed_cards.saved_at, before));
  return db().select().from(feed_cards).where(and(...conds)).orderBy(desc(feed_cards.saved_at)).limit(limit).all();
}

export function markServed(ids: string[], at: number): void {
  if (ids.length === 0) return;
  db()
    .update(feed_cards)
    .set({ served_at: at })
    .where(and(inArray(feed_cards.id, ids), isNull(feed_cards.served_at)))
    .run();
}

export function recentTitles(n: number): string[] {
  return db()
    .select({ t: feed_cards.title })
    .from(feed_cards)
    .where(eq(feed_cards.feed, "invented"))
    .orderBy(desc(feed_cards.created_at))
    .limit(n)
    .all()
    .map((r) => r.t);
}

export function usedMuseumRefs(): Set<string> {
  return new Set(
    db()
      .select({ r: feed_cards.source_ref })
      .from(feed_cards)
      .where(sql`${feed_cards.source_ref} IS NOT NULL`)
      .all()
      .map((r) => r.r as string),
  );
}

/** Boot sweep: anything still pending was killed by a redeploy. */
export function failStalePending(): number {
  const r = db()
    .update(feed_cards)
    .set({ status: "failed", error: "server_restart" })
    .where(eq(feed_cards.status, "pending"))
    .run();
  return r.changes;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
