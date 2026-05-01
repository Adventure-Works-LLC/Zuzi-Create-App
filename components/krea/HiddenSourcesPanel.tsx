"use client";

/**
 * HiddenSourcesPanel — slide-in drawer from the right showing sources whose
 * archived_at is non-null. The recovery surface for the SourceStrip's "Hide"
 * action.
 *
 * Mirrors FavoritesPanel's lifecycle: lazy fetch on open, refetch each open,
 * Esc-to-close, gated against the lightbox so a layered Esc unwinds the
 * topmost surface first.
 *
 * Per Zuzi's feature spec the panel is the "where did my hidden sources go"
 * answer. Each row has Unhide (clears archived_at, source returns to the
 * active strip) + Delete forever (hard delete: cascades iterations + tiles,
 * cleans up R2). Both actions live behind the same ActionMenu component
 * used elsewhere — discoverable, touch-target safe, destructive-tinted.
 */

import { useEffect, useState } from "react";
import { Archive, EyeOff, Loader2, RotateCcw, Trash2, X } from "lucide-react";

import { useCanvas } from "@/stores/canvas";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useSources } from "@/hooks/useSources";

interface HiddenSourceRow {
  id: string;
  inputKey: string;
  originalFilename: string | null;
  w: number;
  h: number;
  aspectRatio: string;
  createdAt: number;
  archivedAt: number | null;
}

function HiddenSourceThumb({
  source,
  pendingAction,
  onUnhide,
  onDeleteForever,
}: {
  source: HiddenSourceRow;
  pendingAction: "unhide" | "delete" | null;
  onUnhide: () => void;
  onDeleteForever: () => void;
}) {
  const { url } = useImageUrl(source.inputKey);
  // Mirror the source aspect ratio on the container so portraits aren't
  // center-cropped to square — same pattern as FavoritesPanel's thumbs.
  return (
    <div className="flex items-stretch gap-3 rounded-lg border border-hairline/50 bg-card/60 p-2">
      <div
        style={{ aspectRatio: source.aspectRatio.replace(":", "/") }}
        className="relative w-24 shrink-0 overflow-hidden rounded-md ring-1 ring-hairline/60"
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
      <div className="flex flex-1 flex-col justify-center gap-1.5 min-w-0">
        <div className="caption-display text-xs text-text-mute truncate">
          {source.originalFilename ?? "untitled source"}
        </div>
        <div className="text-[11px] text-text-mute/80">
          hidden {formatRelativeTime(source.archivedAt ?? source.createdAt)}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={onUnhide}
            disabled={pendingAction !== null}
            className={[
              "inline-flex items-center gap-1.5 rounded-full",
              "border border-hairline/60 bg-secondary",
              "px-3 py-1.5 text-xs",
              "text-foreground hover:bg-secondary/80",
              "transition-colors disabled:opacity-50 no-callout",
            ].join(" ")}
            aria-label={`Unhide ${source.originalFilename ?? "source"}`}
          >
            {pendingAction === "unhide" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Unhide
          </button>
          <button
            type="button"
            onClick={onDeleteForever}
            disabled={pendingAction !== null}
            className={[
              "inline-flex items-center gap-1.5 rounded-full",
              "border border-destructive/40 bg-destructive/10",
              "px-3 py-1.5 text-xs",
              "text-destructive hover:bg-destructive/20",
              "transition-colors disabled:opacity-50 no-callout",
            ].join(" ")}
            aria-label={`Delete ${source.originalFilename ?? "source"} forever`}
          >
            {pendingAction === "delete" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Delete forever
          </button>
        </div>
      </div>
    </div>
  );
}

/** Loose relative-time formatter — "2h ago", "3d ago" — for the row meta
 *  line. The DOM intl APIs would be more accurate but pulling in
 *  `Intl.RelativeTimeFormat` for a single secondary caption is overkill;
 *  a hand-rolled shim keeps the bundle smaller. Falls back to a date
 *  string for >30d. */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function HiddenSourcesPanel() {
  const open = useCanvas((s) => s.hiddenSourcesOpen);
  const setOpen = useCanvas((s) => s.setHiddenSourcesOpen);
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);
  const { restore, deletePermanent } = useSources();

  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<HiddenSourceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Per-row pending state so the user sees feedback on the row they
   *  tapped without locking the entire panel during a slow request. */
  const [pendingByRow, setPendingByRow] = useState<
    Record<string, "unhide" | "delete">
  >({});

  // Lazy fetch on open; refetch each open so a fresh hide elsewhere shows
  // up immediately. Refresh when an action lands locally too.
  const refresh = async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/sources?archived=true&limit=100", {
        signal,
      });
      if (!resp.ok) {
        throw new Error(`hidden sources fetch failed (${resp.status})`);
      }
      const data = (await resp.json()) as { sources: HiddenSourceRow[] };
      setHidden(data.sources);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    void refresh(ac.signal);
    return () => ac.abort();
  }, [open]);

  // Esc-to-close. Gate against the lightbox so a layered Esc unwinds the
  // topmost surface first (mirrors FavoritesPanel's pattern).
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

  const handleUnhide = async (sourceId: string) => {
    setPendingByRow((p) => ({ ...p, [sourceId]: "unhide" }));
    setError(null);
    try {
      await restore(sourceId);
      // Drop from this panel's local list — restore() also refreshes the
      // active strip via useSources so the source reappears there.
      setHidden((prev) => prev.filter((s) => s.id !== sourceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingByRow((p) => {
        const { [sourceId]: _, ...rest } = p;
        return rest;
      });
    }
  };

  const handleDelete = async (sourceId: string, displayName: string) => {
    const ok = window.confirm(
      `This permanently deletes "${displayName}" and all generations made from it. This cannot be undone.\n\nDelete?`,
    );
    if (!ok) return;
    setPendingByRow((p) => ({ ...p, [sourceId]: "delete" }));
    setError(null);
    try {
      await deletePermanent(sourceId);
      setHidden((prev) => prev.filter((s) => s.id !== sourceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingByRow((p) => {
        const { [sourceId]: _, ...rest } = p;
        return rest;
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hidden sources"
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
          <div className="flex items-center gap-2.5">
            <Archive
              className="h-5 w-5 text-text-mute"
              strokeWidth={1.5}
              aria-hidden
            />
            <h2 className="font-display text-2xl tracking-tight text-foreground">
              Hidden sources
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-2 text-text-mute hover:text-foreground hover:bg-secondary transition-colors no-callout"
            aria-label="Close hidden sources"
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
            <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && hidden.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-20 text-text-mute">
              <EyeOff className="h-6 w-6" strokeWidth={1.5} aria-hidden />
              <p className="caption-display text-sm italic">
                No hidden sources. Tap the &ldquo;&hellip;&rdquo; on a source
                to hide it.
              </p>
            </div>
          )}
          {!loading && hidden.length > 0 && (
            <div className="flex flex-col gap-3">
              {hidden.map((s) => (
                <HiddenSourceThumb
                  key={s.id}
                  source={s}
                  pendingAction={pendingByRow[s.id] ?? null}
                  onUnhide={() => void handleUnhide(s.id)}
                  onDeleteForever={() =>
                    void handleDelete(
                      s.id,
                      s.originalFilename ?? "this source",
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
