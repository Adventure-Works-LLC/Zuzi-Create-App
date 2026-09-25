/**
 * GET /api/feed/:id/related — what the card's detail view shows under it
 * (AGENTS.md §18): its versions ("Paint again" results, same original), its
 * "More like this" pairs, and similar existing cards (same artist / era).
 * `painting` counts children still in flight so the page can show
 * placeholders and keep polling.
 *
 * Auth required. runtime = 'nodejs' for better-sqlite3.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/requireAuth";
import { toDTO, toDTOs } from "@/lib/feed/dto";
import { getCard, listChildren, listSimilar } from "@/lib/feed/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const card = getCard(id);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Versions live on the root pair; a version's detail view shows its siblings.
  const parent = card.parent_id ? getCard(card.parent_id) : undefined;
  const root = parent && parent.orig_key === card.orig_key ? parent : card;
  const versionRows = [root, ...listChildren(root.id).filter((c) => c.orig_key === root.orig_key)];
  const likeRows = listChildren(card.id).filter((c) => c.orig_key !== card.orig_key || c.status === "pending" && !c.orig_key);
  const ready = (rows: typeof versionRows) => rows.filter((r) => r.status === "ready");
  const similar = listSimilar(root, 12).filter((c) => c.id !== card.id);
  return NextResponse.json({
    root: await toDTO(root),
    versions: await toDTOs(ready(versionRows)),
    versionsPainting: versionRows.filter((r) => r.status === "pending").length,
    like: await toDTOs(ready(likeRows)),
    likePainting: likeRows.filter((r) => r.status === "pending").length,
    similar: await toDTOs(similar),
  });
}
