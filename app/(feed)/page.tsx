"use client";

/**
 * Zuzi's Scroll — the home page (v7, AGENTS.md §18).
 *
 * A Pinterest-style scroll of HER versions of great paintings. Every card is
 * a pair — the painting + her version — shown hers-first.
 *   - Museum (default): her versions of blue-chip public-domain paintings
 *     from the great museums.
 *   - Modern: her versions of invented contemporary museum pieces (1995–2025
 *     styles; real works that recent are under copyright).
 *   - Invented: her versions of museum-grade paintings that don't exist.
 *   - Saved: everything she hearted.
 * On a card: the chip flips to the painting it came from, the dots repaint
 * it in her palettes or a colorist's, the heart saves it. Tapping the
 * painting opens it big: "Paint again" makes a new version (all versions are
 * kept with the pair), and scrolling down shows "More like this" — new
 * pairs painted from this one, plus similar ones.
 *
 * The server paints as she scrolls (~2–3 min a card) and keeps a stock of
 * unseen cards ahead of her; at the bottom the page shows the ones being
 * painted and appends them as they finish.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/auth/authFetch";

type Tab = "museum" | "modern" | "invented" | "saved";

interface PaletteDTO {
  key: string;
  name: string;
  chips: string[];
  url: string | null;
}

interface CardDTO {
  id: string;
  feed: "invented" | "museum" | "modern";
  title: string;
  afterLabel: string;
  byline: string;
  sourceUrl: string | null;
  her: { url: string; w: number; h: number };
  orig: { url: string; thumb: string; w: number; h: number } | null;
  palettes: PaletteDTO[];
  matisse: { url: string; w: number; h: number } | null;
  saved: boolean;
  savedPalette: string | null;
  readyAt: number;
  savedAt: number | null;
}

interface FeedResponse {
  cards: CardDTO[];
  nextBefore: number | null;
  painting: number;
  stopped?: "daily" | "monthly" | "painter" | null;
}

interface RelatedResponse {
  root: CardDTO | null;
  versions: CardDTO[];
  versionsPainting: number;
  like: CardDTO[];
  likePainting: number;
  similar: CardDTO[];
}

interface Zoom {
  src: string;
  caption: string;
  link: string | null;
  hers: boolean;
}

const HEART = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"
    />
  </svg>
);

// The Matisse checkbox paints cards as they come near the screen — six at a
// time, so a fast scroll doesn't fire twenty paintings at once. Each takes
// about two minutes, so painting starts well below the fold.
const matisseSlots = { active: 0, waiting: [] as (() => void)[] };
async function withMatisseSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (matisseSlots.active >= 6) await new Promise<void>((r) => matisseSlots.waiting.push(r));
  matisseSlots.active++;
  try {
    return await fn();
  } finally {
    matisseSlots.active--;
    matisseSlots.waiting.shift()?.();
  }
}

function patchCard(list: CardDTO[], id: string, patch: (c: CardDTO) => CardDTO): CardDTO[] {
  return list.map((c) => (c.id === id ? patch(c) : c));
}

// Fewer, wider columns so every painting reads big on her iPad: 2 across in
// portrait, 3 in landscape, 4 only on very wide screens.
function columnsFor(width: number): number {
  if (width >= 1500) return 4;
  if (width >= 880) return 3;
  return 2;
}

function useColumns(): number {
  const [cols, setCols] = useState(2);
  useEffect(() => {
    const onResize = () => setCols(columnsFor(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cols;
}

/** Greedy masonry: each card goes to the shortest column, so appends never reshuffle. */
function Masonry({
  cards,
  cols,
  placeholders,
  render,
}: {
  cards: CardDTO[];
  cols: number;
  placeholders: number;
  render: (c: CardDTO) => React.ReactNode;
}) {
  const columns = useMemo(() => {
    const out: (CardDTO | number)[][] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    const place = (item: CardDTO | number, h: number) => {
      let best = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[best]) best = i;
      out[best].push(item);
      heights[best] += h;
    };
    for (const c of cards) place(c, c.her.h / c.her.w + 0.5);
    for (let k = 0; k < placeholders; k++) place(k, 1.25);
    return out;
  }, [cards, cols, placeholders]);
  return (
    <div className="zs-grid">
      {columns.map((col, i) => (
        <div className="zs-col" key={i}>
          {col.map((item) =>
            typeof item === "number" ? (
              <div className="zs-painting" key={`p${item}`}>
                Painting a new one…
                <br />
                about two minutes
              </div>
            ) : (
              <div key={item.id}>{render(item)}</div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

export default function ScrollPage() {
  const [tab, setTab] = useState<Tab>("museum");
  const [cards, setCards] = useState<CardDTO[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [painting, setPainting] = useState(0);
  const [stopped, setStopped] = useState<FeedResponse["stopped"]>(null);
  const [tune, setTune] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [detail, setDetail] = useState<string[]>([]);
  const [matisse, setMatisse] = useState(false);
  const cols = useColumns();

  useEffect(() => {
    try {
      setMatisse(window.localStorage.getItem("zs-matisse") === "1");
    } catch {
      // storage unavailable — default to her versions
    }
  }, []);
  const toggleMatisse = (on: boolean) => {
    setMatisse(on);
    try {
      window.localStorage.setItem("zs-matisse", on ? "1" : "0");
    } catch {
      // per-device convenience only
    }
  };

  const tabRef = useRef<Tab>(tab);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);
  const cardsRef = useRef<CardDTO[]>([]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    document.title = "Zuzi's Scroll";
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const load = useCallback(
    async (mode: "first" | "older" | "since") => {
      if (busy.current) return;
      const t = tabRef.current;
      const params = new URLSearchParams({ feed: t, limit: "20" });
      if (mode === "older" && nextBefore !== null) params.set("before", String(nextBefore));
      if (mode === "since") {
        const newest = cardsRef.current.reduce((m, c) => Math.max(m, c.readyAt), 0);
        params.set("since", String(newest));
      }
      busy.current = true;
      if (mode !== "since") setLoading(true);
      try {
        const r = await authFetch(`/api/feed?${params.toString()}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as FeedResponse;
        if (tabRef.current !== t) return;
        setPainting(data.painting);
        setStopped(data.stopped ?? null);
        if (mode === "first") {
          setCards(data.cards);
        } else if (data.cards.length > 0) {
          setCards((prev) => {
            const have = new Set(prev.map((c) => c.id));
            return [...prev, ...data.cards.filter((c) => !have.has(c.id))];
          });
        }
        if (mode !== "since") setNextBefore(data.nextBefore);
        setLoadedOnce(true);
      } catch (e) {
        if (e instanceof Error && e.message === "session_expired") return;
        if (mode !== "since") flash("Couldn't load the scroll. Try again in a moment.");
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [nextBefore, flash],
  );

  // First page whenever the tab changes.
  useEffect(() => {
    tabRef.current = tab;
    setCards([]);
    setNextBefore(null);
    setLoadedOnce(false);
    setPainting(0);
    setStopped(null);
    busy.current = false;
    void load("first");
    window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Infinite scroll: older pages while there are any.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && nextBefore !== null && !busy.current) void load("older");
      },
      { rootMargin: "1400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextBefore, load]);

  // At the end of a live feed: keep checking for newly painted cards.
  const atEnd = loadedOnce && nextBefore === null && tab !== "saved";
  useEffect(() => {
    if (!atEnd) return;
    const id = window.setInterval(() => void load("since"), 10_000);
    return () => window.clearInterval(id);
  }, [atEnd, load]);

  const markSaved = useCallback((id: string, saved: boolean) => {
    setCards((prev) =>
      tabRef.current === "saved" && !saved ? prev.filter((c) => c.id !== id) : prev.map((c) => (c.id === id ? { ...c, saved } : c)),
    );
  }, []);

  const save = useCallback(
    async (card: CardDTO, saved: boolean, palette: string | null) => {
      markSaved(card.id, saved);
      try {
        const r = await authFetch(`/api/feed/${card.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ saved, palette }),
        });
        if (!r.ok) throw new Error(String(r.status));
        return true;
      } catch (e) {
        if (e instanceof Error && e.message === "session_expired") return false;
        markSaved(card.id, !saved);
        flash("Couldn't save that one. Try again.");
        return false;
      }
    },
    [markSaved, flash],
  );

  const fillPalette = useCallback((cardId: string, key: string, url: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, palettes: c.palettes.map((p) => (p.key === key ? { ...p, url } : p)) } : c)),
    );
  }, []);

  const fillMatisse = useCallback((cardId: string, url: string) => {
    setCards((prev) =>
      patchCard(prev, cardId, (c) => ({ ...c, matisse: { url, w: c.orig?.w ?? c.her.w, h: c.orig?.h ?? c.her.h } })),
    );
  }, []);

  const tuneStyle = useMemo(() => {
    const x = tune / 10;
    return {
      "--zs-sat": String(1 + 0.55 * x),
      "--zs-con": String(1 + 0.07 * x),
      "--zs-bri": String(1 + 0.02 * x),
    } as React.CSSProperties;
  }, [tune]);

  const placeholders = atEnd ? Math.min(painting, cols * 2) : 0;
  const openDetail = useCallback((id: string) => setDetail((s) => [...s, id]), []);

  return (
    <div style={tuneStyle}>
      <div className="zs-wrap">
        <header className="zs-head">
          <div>
            <h1 className="zs-title">Zuzi&rsquo;s Scroll</h1>
            <p className="zs-sub">Her versions of great paintings, real and invented.</p>
          </div>
          <div className="zs-controls">
            <div className="zs-tabs" role="group" aria-label="Feed">
              {(["museum", "modern", "invented", "saved"] as const).map((t) => (
                <button key={t} type="button" className="zs-tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
                  {t === "museum" ? "Museum" : t === "modern" ? "Modern" : t === "invented" ? "Invented" : "Saved"}
                </button>
              ))}
            </div>
            <label className="zs-tune" htmlFor="zs-tune">
              Softer
              <input
                id="zs-tune"
                type="range"
                min={-10}
                max={10}
                step={1}
                value={tune}
                onChange={(e) => setTune(Number(e.target.value))}
                aria-label="Color strength"
              />
              Bolder
            </label>
            <label className="zs-check" htmlFor="zs-matisse">
              <input
                id="zs-matisse"
                type="checkbox"
                checked={matisse}
                onChange={(e) => toggleMatisse(e.target.checked)}
              />
              Painted by Matisse
            </label>
            <nav className="zs-links" aria-label="Elsewhere">
              <a href="/studio">Studio</a>
              <a href="/logout">Sign out</a>
            </nav>
          </div>
        </header>

        {loadedOnce && cards.length === 0 && placeholders === 0 ? (
          <p className="zs-empty">
            {tab === "saved"
              ? "Nothing saved yet. Tap the heart on any painting."
              : "The first ones are being painted now. Each takes about two minutes."}
          </p>
        ) : null}

        <Masonry
          cards={cards}
          cols={cols}
          placeholders={placeholders}
          render={(c) => (
            <Card
              card={c}
              matisse={matisse}
              onSave={save}
              onFill={fillPalette}
              onMatisse={fillMatisse}
              onOpen={() => openDetail(c.id)}
              onError={flash}
            />
          )}
        />
        <div ref={sentinel} className="zs-sentinel" aria-hidden="true" />
        {loading && cards.length > 0 ? <p className="zs-empty">Loading more…</p> : null}
        {atEnd && cards.length > 0 ? (
          <p className="zs-empty">
            {painting > 0
              ? `${painting} new ${painting === 1 ? "one is" : "ones are"} being painted — they'll appear here as they finish.`
              : stopped === "daily"
                ? "That's everything for today. New ones start painting tomorrow."
                : stopped === "monthly"
                  ? "This month's painting budget is used up."
                  : stopped === "painter"
                    ? "New paintings are paused right now. They'll pick up again soon."
                    : "New ones are on their way."}
          </p>
        ) : null}
      </div>

      {detail.length > 0 ? (
        <Detail
          key={detail[detail.length - 1]}
          id={detail[detail.length - 1]}
          depth={detail.length}
          cols={Math.min(cols, 3)}
          onBack={() => setDetail((s) => s.slice(0, -1))}
          onClose={() => setDetail([])}
          onOpen={openDetail}
          onSave={save}
          onZoom={setZoom}
          onError={flash}
          matisse={matisse}
          onToggleMatisse={toggleMatisse}
        />
      ) : null}

      {zoom ? (
        <div
          className="zs-lb"
          role="dialog"
          aria-modal="true"
          aria-label="Painting"
          onClick={(e) => {
            if (e.target === e.currentTarget) setZoom(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setZoom(null);
          }}
        >
          <button type="button" className="zs-x" onClick={() => setZoom(null)} autoFocus>
            Close
          </button>
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={zoom.src} alt={zoom.caption} className={zoom.hers ? "zs-hers" : undefined} />
            <p>
              {zoom.caption}{" "}
              {zoom.link ? (
                <a href={zoom.link} target="_blank" rel="noopener noreferrer">
                  More about this painting
                </a>
              ) : null}
            </p>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="zs-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** A card opened big: its versions, "Paint again", and "More like this". */
function Detail({
  id,
  depth,
  cols,
  onBack,
  onClose,
  onOpen,
  onSave,
  onZoom,
  onError,
  matisse,
  onToggleMatisse,
}: {
  matisse: boolean;
  onToggleMatisse: (on: boolean) => void;
  id: string;
  depth: number;
  cols: number;
  onBack: () => void;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSave: (card: CardDTO, saved: boolean, palette: string | null) => Promise<boolean>;
  onZoom: (z: Zoom) => void;
  onError: (msg: string) => void;
}) {
  const [data, setData] = useState<RelatedResponse | null>(null);
  const [current, setCurrent] = useState<string>(id);
  const [asked, setAsked] = useState(false);
  const [againBusy, setAgainBusy] = useState(false);
  const moreRef = useRef<HTMLHeadingElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch(`/api/feed/${id}/related`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as RelatedResponse);
    } catch (e) {
      if (e instanceof Error && e.message === "session_expired") return;
      onError("Couldn't open that painting. Try again.");
    }
  }, [id, onError]);

  useEffect(() => {
    void refresh();
    scroller.current?.scrollTo(0, 0);
  }, [refresh]);

  const inFlight = (data?.versionsPainting ?? 0) + (data?.likePainting ?? 0);
  useEffect(() => {
    if (inFlight === 0) return;
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, [inFlight, refresh]);

  // Scrolling down into "More like this" asks for new pairs like this one.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || asked || !data) return;
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setAsked(true);
        try {
          const r = await authFetch(`/api/feed/${id}/more`, { method: "POST" });
          const body = (await r.json()) as { ok: boolean; message?: string };
          if (!body.ok && body.message) onError(body.message);
          void refresh();
        } catch (e) {
          if (e instanceof Error && e.message === "session_expired") return;
        }
      },
      { root: scroller.current, rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id, asked, data, onError, refresh]);

  async function again(target: string, today = false) {
    if (againBusy) return;
    setAgainBusy(true);
    try {
      const r = await authFetch(`/api/feed/${target}/again`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ today }),
      });
      const body = (await r.json()) as { ok: boolean; message?: string };
      if (body.message) onError(body.message);
      void refresh();
    } catch (e) {
      if (e instanceof Error && e.message === "session_expired") return;
      onError("Couldn't start a new version. Try again.");
    } finally {
      setAgainBusy(false);
    }
  }

  const versions = data?.versions ?? [];
  const shown = versions.find((v) => v.id === current) ?? versions.find((v) => v.id === id) ?? data?.root ?? null;
  const fill = (cardId: string, key: string, url: string) =>
    setData((d) =>
      d
        ? {
            ...d,
            versions: d.versions.map((c) =>
              c.id === cardId ? { ...c, palettes: c.palettes.map((p) => (p.key === key ? { ...p, url } : p)) } : c,
            ),
          }
        : d,
    );
  const fillMatisseLocal = (cardId: string, url: string) =>
    setData((d) => {
      if (!d) return d;
      const f = (c: CardDTO) => ({ ...c, matisse: { url, w: c.orig?.w ?? c.her.w, h: c.orig?.h ?? c.her.h } });
      return {
        ...d,
        root: d.root && d.root.id === cardId ? f(d.root) : d.root,
        versions: patchCard(d.versions, cardId, f),
        like: patchCard(d.like, cardId, f),
        similar: patchCard(d.similar, cardId, f),
      };
    });
  const setSavedLocal = (cardId: string, saved: boolean) =>
    setData((d) => (d ? { ...d, versions: d.versions.map((c) => (c.id === cardId ? { ...c, saved } : c)) } : d));
  const more = [...(data?.like ?? []), ...(data?.similar ?? [])];

  return (
    <div className="zs-detail" ref={scroller} role="dialog" aria-modal="true" aria-label={shown?.title ?? "Painting"}>
      <div className="zs-detail-bar">
        <button type="button" className="zs-back" onClick={depth > 1 ? onBack : onClose}>
          {depth > 1 ? "← Back" : "← Scroll"}
        </button>
        {/* The same checkbox as the Scroll header — Jeff looked for it here. */}
        <div className="zs-detail-tools">
          <label className="zs-check" htmlFor="zs-matisse-detail">
            <input
              id="zs-matisse-detail"
              type="checkbox"
              checked={matisse}
              onChange={(e) => onToggleMatisse(e.target.checked)}
            />
            Painted by Matisse
          </label>
          {depth > 1 ? (
            <button type="button" className="zs-back zs-back--quiet" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>

      <div className="zs-detail-main">
        {shown ? (
          <Card
            key={shown.id}
            card={shown}
            big
            matisse={matisse}
            onMatisse={fillMatisseLocal}
            onSave={async (c, saved, palette) => {
              setSavedLocal(c.id, saved);
              if (!(await onSave(c, saved, palette))) setSavedLocal(c.id, !saved);
            }}
            onFill={fill}
            onOpen={(z) => onZoom(z)}
            onError={onError}
          />
        ) : (
          <div className="zs-painting zs-painting--big">Opening…</div>
        )}

        <div className="zs-actions">
          <button
            type="button"
            className="zs-primary"
            onClick={() => shown && void again(shown.id)}
            disabled={!shown || againBusy}
          >
            Paint again
          </button>
          {shown && shown.feed !== "modern" ? (
            <button
              type="button"
              className="zs-primary zs-primary--alt"
              onClick={() => void again(shown.id, true)}
              disabled={againBusy}
            >
              Bring it to today
            </button>
          ) : null}
          <span className="zs-hint">A new version from the same painting — every version stays here. &ldquo;Today&rdquo; keeps the poses and puts it in the present day.</span>
        </div>

        {versions.length > 1 || (data?.versionsPainting ?? 0) > 0 ? (
          <div className="zs-versions" role="group" aria-label="Versions">
            {versions.map((v, i) => (
              <button
                key={v.id}
                type="button"
                className="zs-vthumb"
                aria-pressed={shown?.id === v.id}
                aria-label={`Version ${i + 1}`}
                onClick={() => setCurrent(v.id)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.her.url} alt="" />
              </button>
            ))}
            {Array.from({ length: data?.versionsPainting ?? 0 }).map((_, k) => (
              <div key={`vp${k}`} className="zs-vthumb zs-vthumb--painting" aria-label="Painting a new version">
                painting…
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <h2 className="zs-section-title" ref={moreRef}>
        More like this
      </h2>
      <Masonry
        cards={more}
        cols={cols}
        placeholders={data?.likePainting ?? 0}
        render={(c) => (
          <Card
            card={c}
            matisse={matisse}
            onSave={onSave}
            onFill={() => undefined}
            onMatisse={fillMatisseLocal}
            onOpen={() => onOpen(c.id)}
            onError={onError}
          />
        )}
      />
      {data && more.length === 0 && (data.likePainting ?? 0) === 0 ? (
        <p className="zs-empty">{asked ? "Painting some like this now…" : "Scroll down to paint more like this."}</p>
      ) : null}
    </div>
  );
}

function Card({
  card,
  big,
  matisse,
  onSave,
  onFill,
  onMatisse,
  onOpen,
  onError,
}: {
  card: CardDTO;
  big?: boolean;
  matisse?: boolean;
  onMatisse?: (cardId: string, url: string) => void;
  onSave: (card: CardDTO, saved: boolean, palette: string | null) => void | Promise<unknown>;
  onFill: (cardId: string, key: string, url: string) => void;
  onOpen: (z: Zoom) => void;
  onError: (msg: string) => void;
}) {
  const initial =
    card.savedPalette && card.palettes.some((p) => p.key === card.savedPalette && p.url) ? card.savedPalette : null;
  const [palette, setPalette] = useState<string | null>(initial);
  const [showOrig, setShowOrig] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [mState, setMState] = useState<"idle" | "painting" | "failed">("idle");
  const figRef = useRef<HTMLElement | null>(null);

  // Matisse checkbox: paint this card's Matisse version once it comes within
  // about two screens of view.
  useEffect(() => {
    if (!matisse || card.matisse || !card.orig || !onMatisse) return;
    const el = figRef.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setMState("painting");
        void withMatisseSlot(async () => {
          // The server paints in the background (~2 min); ask every 8 seconds.
          while (!cancelled) {
            const r = await authFetch(`/api/feed/${card.id}/matisse`, { method: "POST" });
            if (!r.ok) throw new Error(String(r.status));
            const { url } = (await r.json()) as { url?: string };
            if (url) return void (!cancelled && onMatisse(card.id, url));
            await new Promise((res) => setTimeout(res, 8000));
          }
        })
          .then(() => !cancelled && setMState("idle"))
          .catch(() => !cancelled && setMState("failed"));
      },
      { rootMargin: "1600px 0px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [matisse, card.matisse, card.orig, card.id, onMatisse]);

  const current = card.palettes.find((p) => p.key === palette && p.url);
  const asMatisse = !!(matisse && !showOrig && card.matisse);
  const src = showOrig && card.orig ? card.orig.url : asMatisse && card.matisse ? card.matisse.url : current?.url ?? card.her.url;
  const dims = showOrig && card.orig ? card.orig : asMatisse && card.matisse ? card.matisse : card.her;
  const palName = asMatisse ? "as Matisse would paint it" : current ? current.name : "as made";
  // While Matisse paints (~2 min) her version dims under a clear label, so
  // ticking the box visibly does something (Jeff: "nothing changed").
  const mWaiting = matisse && !showOrig && !card.matisse && mState !== "failed";

  async function pick(p: PaletteDTO) {
    setShowOrig(false);
    if (p.url) {
      setPalette(p.key);
      return;
    }
    if (pending) return;
    setPending(p.key);
    try {
      const r = await authFetch(`/api/feed/${card.id}/variant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palette: p.key }),
      });
      if (!r.ok) throw new Error(r.status === 429 ? "cap" : String(r.status));
      const { url } = (await r.json()) as { url: string };
      onFill(card.id, p.key, url);
      setPalette(p.key);
    } catch (e) {
      if (e instanceof Error && e.message === "session_expired") return;
      onError(
        e instanceof Error && e.message === "cap"
          ? "This month's painting budget is used up."
          : `Couldn't repaint it in ${p.name} right now. Try again in a moment.`,
      );
    } finally {
      setPending(null);
    }
  }

  const caption = showOrig
    ? `${card.feed === "museum" ? "The original" : "The invented original"}: ${card.title} · ${card.byline}`
    : asMatisse
      ? `As if Matisse painted it: ${card.title} · ${card.byline}`
      : `Her version, ${palName}: ${card.title} · ${card.byline}`;

  return (
    <figure className={`zs-card${big ? " zs-card--big" : ""}`} ref={figRef}>
      <div className="zs-media">
        <button
          type="button"
          className="zs-imgbox"
          aria-label={big ? `Zoom into ${card.title}` : `Open ${card.title}`}
          onClick={() => onOpen({ src, caption, link: card.sourceUrl, hers: !showOrig })}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={showOrig ? `${card.title}, the painting her version was made from` : `Her version of ${card.title}, ${palName}`}
            width={dims.w}
            height={dims.h}
            loading={big ? "eager" : "lazy"}
            className={showOrig ? undefined : mWaiting ? "zs-hers zs-waiting" : "zs-hers"}
          />
        </button>
        {showOrig ? (
          <span className="zs-origtag">{card.feed === "museum" ? "The original" : "The invented original"}</span>
        ) : matisse && !card.matisse ? (
          <span className="zs-origtag zs-mtag">
            {mState === "failed" ? "Matisse couldn't paint this one" : "Matisse is painting… about 2 min"}
          </span>
        ) : null}
        <button
          type="button"
          className="zs-save"
          aria-label={card.saved ? "Remove from saved" : "Save this painting"}
          aria-pressed={card.saved}
          onClick={() => void onSave(card, !card.saved, asMatisse ? "matisse" : palette)}
        >
          {HEART}
        </button>
      </div>
      <figcaption className="zs-meta">
        <div className="zs-dots" role="group" aria-label="Colors" hidden={matisse && !showOrig}>
          <button
            type="button"
            className="zs-dot zs-asmade"
            title="As made"
            aria-label="Colors as made"
            aria-pressed={!palette && !showOrig}
            onClick={() => {
              setShowOrig(false);
              setPalette(null);
            }}
          />
          {card.palettes.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`zs-dot${pending === p.key ? " zs-busy" : ""}`}
              title={p.name}
              aria-label={`${p.name} palette${p.url ? "" : " (paints on tap)"}`}
              aria-pressed={palette === p.key && !showOrig}
              style={{ background: `conic-gradient(${p.chips[0]} 0 50%, ${p.chips[1]} 50% 80%, ${p.chips[2]} 80% 100%)` }}
              onClick={() => void pick(p)}
            />
          ))}
          <span className="zs-palname">{showOrig ? "" : pending ? "painting…" : palName}</span>
        </div>
        {matisse && !showOrig ? (
          <p className="zs-palname zs-matisse-label">{mWaiting ? "Matisse is painting this one" : palName}</p>
        ) : null}
        <p className="zs-cardtitle">{card.title}</p>
        {big ? <p className="zs-byline">{card.byline}</p> : null}
        {card.orig ? (
          <button type="button" className="zs-after" aria-pressed={showOrig} onClick={() => setShowOrig((v) => !v)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.orig.thumb} alt="" loading="lazy" />
            <span>{showOrig ? "Back to her version" : card.afterLabel}</span>
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}
