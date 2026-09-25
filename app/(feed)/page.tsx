"use client";

/**
 * Zuzi's Scroll — the home page (v7, AGENTS.md §18).
 *
 * A Pinterest-style scroll of HER versions of great paintings. Two feeds:
 *   - Invented: an AI paints a museum-grade painting that doesn't exist,
 *     then her version of it (every image unique).
 *   - Museum: her versions of public-domain paintings that rhyme with her
 *     work (the Met, the Art Institute of Chicago).
 * Each card shows hers first; the chip under it flips to the painting it
 * was made from; the dots repaint it in her palettes or a colorist's; the
 * top slider makes every painting softer or bolder; the heart saves it.
 *
 * The server paints as she scrolls: each read tops up a buffer of unseen
 * cards (~2–3 min per card). When she reaches the end, the page keeps
 * polling and appends new cards at the bottom as they finish.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/auth/authFetch";

type Tab = "invented" | "museum" | "saved";

interface PaletteDTO {
  key: string;
  name: string;
  chips: string[];
  url: string | null;
}

interface CardDTO {
  id: string;
  feed: "invented" | "museum";
  title: string;
  afterLabel: string;
  byline: string;
  sourceUrl: string | null;
  her: { url: string; w: number; h: number };
  orig: { url: string; thumb: string; w: number; h: number } | null;
  palettes: PaletteDTO[];
  saved: boolean;
  savedPalette: string | null;
  readyAt: number;
  savedAt: number | null;
}

interface FeedResponse {
  cards: CardDTO[];
  nextBefore: number | null;
  painting: number;
}

const HEART = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"
    />
  </svg>
);

function columnsFor(width: number): number {
  if (width >= 1040) return 4;
  if (width >= 640) return 3;
  return 2;
}

export default function ScrollPage() {
  const [tab, setTab] = useState<Tab>("invented");
  const [cards, setCards] = useState<CardDTO[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [painting, setPainting] = useState(0);
  const [tune, setTune] = useState(0);
  const [cols, setCols] = useState(2);
  const [toast, setToast] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{
    src: string;
    caption: string;
    link: string | null;
    hers: boolean;
  } | null>(null);

  const tabRef = useRef<Tab>(tab);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);
  const cardsRef = useRef<CardDTO[]>([]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    document.title = "Zuzi's Scroll";
    const onResize = () => setCols(columnsFor(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(
    async (mode: "first" | "older" | "since") => {
      if (busy.current) return;
      const t = tabRef.current;
      const params = new URLSearchParams({ feed: t, limit: "20" });
      if (mode === "older" && nextBefore !== null)
        params.set("before", String(nextBefore));
      if (mode === "since") {
        const newest = cardsRef.current.reduce(
          (m, c) => Math.max(m, c.readyAt),
          0,
        );
        params.set("since", String(newest));
      }
      busy.current = true;
      if (mode !== "since") setLoading(true);
      try {
        const r = await authFetch(`/api/feed?${params.toString()}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as FeedResponse;
        if (tabRef.current !== t) return;
        setPainting(data.painting);
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
        if (mode !== "since")
          flash("Couldn't load the scroll. Try again in a moment.");
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
        if (
          entries.some((e) => e.isIntersecting) &&
          nextBefore !== null &&
          !busy.current
        )
          void load("older");
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextBefore, load]);

  // At the end of a live feed: keep checking for newly painted cards.
  const atEnd = loadedOnce && nextBefore === null && tab !== "saved";
  useEffect(() => {
    if (!atEnd) return;
    const id = window.setInterval(() => void load("since"), 15_000);
    return () => window.clearInterval(id);
  }, [atEnd, load]);

  const setSaved = useCallback(
    async (card: CardDTO, saved: boolean, palette: string | null) => {
      setCards((prev) =>
        tabRef.current === "saved" && !saved
          ? prev.filter((c) => c.id !== card.id)
          : prev.map((c) => (c.id === card.id ? { ...c, saved } : c)),
      );
      try {
        const r = await authFetch(`/api/feed/${card.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ saved, palette }),
        });
        if (!r.ok) throw new Error(String(r.status));
      } catch (e) {
        if (e instanceof Error && e.message === "session_expired") return;
        setCards((prev) =>
          prev.map((c) => (c.id === card.id ? { ...c, saved: !saved } : c)),
        );
        flash("Couldn't save that one. Try again.");
      }
    },
    [flash],
  );

  const fillPalette = useCallback(
    (cardId: string, key: string, url: string) => {
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? {
                ...c,
                palettes: c.palettes.map((p) =>
                  p.key === key ? { ...p, url } : p,
                ),
              }
            : c,
        ),
      );
    },
    [],
  );

  // Greedy masonry: each card goes to the currently shortest column, so
  // appending never reshuffles what she's already seen.
  const columns = useMemo(() => {
    const out: CardDTO[][] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    for (const c of cards) {
      let best = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[best]) best = i;
      out[best].push(c);
      heights[best] += c.her.h / c.her.w + 0.42;
    }
    return out;
  }, [cards, cols]);

  const tuneStyle = useMemo(() => {
    const x = tune / 10;
    return {
      "--zs-sat": String(1 + 0.55 * x),
      "--zs-con": String(1 + 0.07 * x),
      "--zs-bri": String(1 + 0.02 * x),
    } as React.CSSProperties;
  }, [tune]);

  const placeholders = atEnd ? Math.min(painting, 3) : 0;

  return (
    <div style={tuneStyle}>
      <div className="zs-wrap">
        <header className="zs-head">
          <div>
            <h1 className="zs-title">Zuzi&rsquo;s Scroll</h1>
            <p className="zs-sub">
              Her versions of great paintings, real and invented.
            </p>
          </div>
          <div className="zs-controls">
            <div className="zs-tabs" role="group" aria-label="Feed">
              {(["invented", "museum", "saved"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="zs-tab"
                  aria-pressed={tab === t}
                  onClick={() => setTab(t)}
                >
                  {t === "invented"
                    ? "Invented"
                    : t === "museum"
                      ? "Museum"
                      : "Saved"}
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
            <nav className="zs-links" aria-label="Elsewhere">
              <a href="/studio">Studio</a>
              <a href="/logout">Sign out</a>
            </nav>
          </div>
        </header>

        {loadedOnce && cards.length === 0 ? (
          <p className="zs-empty">
            {tab === "saved"
              ? "Nothing saved yet. Tap the heart on any painting."
              : painting > 0
                ? "Painting the first few now. Each takes about two minutes."
                : "Nothing here yet. The next ones are on their way."}
          </p>
        ) : null}

        <div className="zs-grid">
          {columns.map((col, i) => (
            <div className="zs-col" key={i}>
              {col.map((c) => (
                <Card
                  key={c.id}
                  card={c}
                  onSave={setSaved}
                  onFill={fillPalette}
                  onOpen={setLightbox}
                  onError={flash}
                />
              ))}
              {Array.from({ length: placeholders }).map((_, k) =>
                k % cols === i ? (
                  <div className="zs-painting" key={`p${k}`}>
                    Painting a new one…
                  </div>
                ) : null,
              )}
            </div>
          ))}
        </div>
        <div ref={sentinel} className="zs-sentinel" aria-hidden="true" />
        {loading && cards.length > 0 ? (
          <p className="zs-empty">Loading more…</p>
        ) : null}
      </div>

      {lightbox ? (
        <div
          className="zs-lb"
          role="dialog"
          aria-modal="true"
          aria-label="Painting"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightbox(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightbox(null);
          }}
        >
          <button
            type="button"
            className="zs-x"
            onClick={() => setLightbox(null)}
            autoFocus
          >
            Close
          </button>
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.src}
              alt={lightbox.caption}
              className={lightbox.hers ? "zs-hers" : undefined}
            />
            <p>
              {lightbox.caption}{" "}
              {lightbox.link ? (
                <a
                  href={lightbox.link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  See it at the museum
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

function Card({
  card,
  onSave,
  onFill,
  onOpen,
  onError,
}: {
  card: CardDTO;
  onSave: (card: CardDTO, saved: boolean, palette: string | null) => void;
  onFill: (cardId: string, key: string, url: string) => void;
  onOpen: (lb: {
    src: string;
    caption: string;
    link: string | null;
    hers: boolean;
  }) => void;
  onError: (msg: string) => void;
}) {
  const initial =
    card.savedPalette &&
    card.palettes.some((p) => p.key === card.savedPalette && p.url)
      ? card.savedPalette
      : null;
  const [palette, setPalette] = useState<string | null>(initial);
  const [showOrig, setShowOrig] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const current = card.palettes.find((p) => p.key === palette && p.url);
  const src =
    showOrig && card.orig ? card.orig.url : (current?.url ?? card.her.url);
  const dims = showOrig && card.orig ? card.orig : card.her;
  const palName = current ? current.name : "as made";

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
    ? `${card.feed === "invented" ? "The invented original" : "The original"}: ${card.title} · ${card.byline}`
    : `Her version, ${palName}: ${card.title} · ${card.byline}`;

  return (
    <figure className="zs-card">
      <div className="zs-media">
        <button
          type="button"
          className="zs-imgbox"
          aria-label={`Open ${card.title} larger`}
          onClick={() =>
            onOpen({ src, caption, link: card.sourceUrl, hers: !showOrig })
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={
              showOrig
                ? `${card.title}, the painting her version was made from`
                : `Her version of ${card.title}, ${palName}`
            }
            width={dims.w}
            height={dims.h}
            loading="lazy"
            className={showOrig ? undefined : "zs-hers"}
          />
        </button>
        {showOrig ? (
          <span className="zs-origtag">
            {card.feed === "invented"
              ? "The invented original"
              : "The original"}
          </span>
        ) : null}
        <button
          type="button"
          className="zs-save"
          aria-label={card.saved ? "Remove from saved" : "Save this painting"}
          aria-pressed={card.saved}
          onClick={() => onSave(card, !card.saved, palette)}
        >
          {HEART}
        </button>
      </div>
      <figcaption className="zs-meta">
        <div className="zs-dots" role="group" aria-label="Colors">
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
              style={{
                background: `conic-gradient(${p.chips[0]} 0 50%, ${p.chips[1]} 50% 80%, ${p.chips[2]} 80% 100%)`,
              }}
              onClick={() => void pick(p)}
            />
          ))}
          <span className="zs-palname">
            {showOrig ? "" : pending ? "painting…" : palName}
          </span>
        </div>
        <p className="zs-cardtitle">{card.title}</p>
        {card.orig ? (
          <button
            type="button"
            className="zs-after"
            aria-pressed={showOrig}
            onClick={() => setShowOrig((v) => !v)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.orig.thumb} alt="" loading="lazy" />
            <span>{showOrig ? "Back to her version" : card.afterLabel}</span>
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}
