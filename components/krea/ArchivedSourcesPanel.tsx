"use client";

/**
 * ArchivedSourcesPanel — slide-in drawer from the right showing archived
 * sources, with per-row Unarchive + Delete Forever actions.
 *
 * Pattern mirrors FavoritesPanel:
 *   - z-40 (Lightbox sits at z-50 above; not relevant here, but
 *     consistent).
 *   - Lazy fetches /api/sources?archived=true on open; refetches each
 *     time the drawer opens so newly-archived sources show up.
 *   - Esc to close.
 *
 * The two actions:
 *   - Unarchive   → PATCH /api/sources/:id {archived:false}, refreshes
 *                    the active SourceStrip via useSources().refresh.
 *                    Optimistically removes the row from this panel's
 *                    local list so the user sees the change without
 *                    waiting for a refetch.
 *   - Delete Forever → window.confirm gate, then DELETE
 *                    /api/sources/:id?permanent=true. Server cleans up
 *                    R2 objects + cascades iterations + tiles. Same
 *                    optimistic local-list removal as unarchive.
 *
 * Both actions surface inline error text per-row on failure (instead of
 * a global toast, since the panel is the entire surface and the user
 * is already focused on the row). On success, the row leaves the list.
 */

import { useEffect, useState } from "react";
import { ArchiveRestore, Loader2, Trash2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useSources } from "@/hooks/useSources";
import { useCanvas } from "@/stores/canvas";

interface ArchivedSourceRow {
  id: string;
  inputKey: string;
  originalFilename: string | null;
  w: number;
  h: number;
  aspectRatio: string;
  createdAt: number;
  archivedAt: number | null;
}

/**
 * Format a unix-ms timestamp like "Apr 22, 2026" — the user wants to know
 * roughly when they archived; precise time-of-day is overkill for this
 * surface (the favorites panel uses similar broad-date framing).
 */
function formatArchivedAt(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** One row in the panel — thumbnail (left) + filename / archived-at meta
 *  (middle) + Unarchive / Delete Forever buttons (right). The row is
 *  self-contained: it owns its own action-busy / error state so a slow
 *  Delete on row N doesn't freeze the others. */
function ArchivedSourceRowCard({
  row,
  onUnarchive,
  onDelete,
}: {
  row: ArchivedSourceRow;
  onUnarchive: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { url } = useImageUrl(row.inputKey);
  const [busy, setBusy] = useState<"unarchive" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUnarchive = async () => {
    if (busy) return;
    setBusy("unarchive");
    setError(null);
    try {
      await onUnarchive();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    // Confirm gate. The destructive guardrail. Once confirmed: optimistic
    // removal happens at the parent level, irreversible R2 cleanup
    // happens server-side, no client-side undo path.
    const ok = window.confirm(
      "This permanently deletes this source and all generations made from it.\nThis cannot be undone. Delete?",
    );
    if (!ok) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-md border border-hairline/50 bg-card p-3">
      <div
        style={{ aspectRatio: row.aspectRatio.replace(":", "/") }}
        className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md ring-1 ring-hairline/60"
      >
        {url ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bloom-warm" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {row.originalFilename ?? "Untitled source"}
        </p>
        <p className="caption-display text-xs text-text-mute">
          {row.archivedAt
            ? `Archived ${formatArchivedAt(row.archivedAt)}`
            : "Archived"}
        </p>
        {error && (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void handleUnarchive()}
          disabled={busy !== null}
          aria-label="Unarchive source"
          className={[
            "flex h-9 w-9 items-center justify-center rounded-full",
            "text-text-mute hover:text-foreground hover:bg-secondary",
            "transition-colors no-callout",
            "disabled:opacity-50 disabled:cursor-wait",
          ].join(" ")}
        >
          {busy === "unarchive" ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          ) : (
            <ArchiveRestore className="h-4 w-4" strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={busy !== null}
          aria-label="Delete source forever"
          className={[
            "flex h-9 w-9 items-center justify-center rounded-full",
            "text-text-mute hover:text-destructive hover:bg-destructive/10",
            "transition-colors no-callout",
            "disabled:opacity-50 disabled:cursor-wait",
          ].join(" ")}
        >
          {busy === "delete" ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          ) : (
            <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          )}
        </button>
      </div>
    </li>
  );
}

export function ArchivedSourcesPanel() {
  const open = useCanvas((s) => s.archivedSourcesPanelOpen);
  const setOpen = useCanvas((s) => s.setArchivedSourcesPanelOpen);
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);

  const { unarchive, deleteForever } = useSources();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ArchivedSourceRow[]>([]);

  // Lazy-fetch on open. Refetch each open so newly-archived sources are
  // visible without needing a page refresh.
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch("/api/sources?archived=true&limit=100", {
          signal: ac.signal,
        });
        if (!resp.ok) {
          throw new Error(`archived sources fetch failed (${resp.status})`);
        }
        const data = (await resp.json()) as { sources: ArchivedSourceRow[] };
        setRows(data.sources);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [open]);

  // Esc-to-close. Same lightbox-deference pattern as FavoritesPanel:
  // if a lightbox is open (by-id or snapshot mode), let its handler
  // consume the Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot]);

  if (!open) return null;

  const removeRow = (id: string) => {
    setRows((cur) => cur.filter((r) => r.id !== id));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Archived sources"
      className="fixed inset-0 z-40 flex"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="flex-1 bg-black/40 backdrop-blur-sm" />
      <aside
        className={[
          "h-dvh w-full max-w-[520px] shrink-0",
          "bg-background border-l border-hairline",
          "flex flex-col",
        ].join(" ")}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          <h2 className="font-display text-2xl tracking-tight text-foreground">
            Archived sources
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-2 text-text-mute hover:text-foreground hover:bg-secondary transition-colors no-callout"
            aria-label="Close archived sources"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {loading && (
            <div className="flex items-center justify-center py-20 text-text-mute">
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
            </div>
          )}
          {error && !loading && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && rows.length === 0 && (
            <p className="caption-display text-sm text-text-mute italic">
              No archived sources.
            </p>
          )}
          {!loading && rows.length > 0 && (
            <ul className="flex flex-col gap-3">
              {rows.map((row) => (
                <ArchivedSourceRowCard
                  key={row.id}
                  row={row}
                  onUnarchive={async () => {
                    await unarchive(row.id);
                    removeRow(row.id);
                  }}
                  onDelete={async () => {
                    await deleteForever(row.id);
                    removeRow(row.id);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
