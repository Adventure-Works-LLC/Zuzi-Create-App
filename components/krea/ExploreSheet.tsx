"use client";

/**
 * ExploreSheet — v2.3 full state machine.
 *
 * Three states the user sees:
 *   idle    → Start screen (header + preview row + footer toggles +
 *             green Start button).
 *   running → Result grid streams in via SSE; cost meter ticks live;
 *             persistent Stop button. For Keep-going mode, an
 *             IntersectionObserver at the grid bottom fires the next
 *             triplet when the user scrolls within ~600px of the bottom.
 *             Stop halts BETWEEN batches; in-flight tiles finish (we've
 *             already paid Gemini for them).
 *   done    → Generate 9 more (bounded mode) + Close; or a stopped
 *             banner with the same Close button.
 *
 * Sticky red banner overlay (independent of state): when POST /api/iterate
 * returns 429 monthly_cap_reached, the sheet shows "Monthly cap reached
 * — $X.XX of $Y.YY" and auto-triggers Stop. No further batches fire.
 *
 * Architecture notes:
 *   - The sheet doesn't manage the SSE or per-tile streaming itself;
 *     useStreamingResults (mounted at the page level) attaches an
 *     EventSource per pending iteration in the canvas store. Tiles
 *     stream into iterations[] via store mutators. The sheet just
 *     READS the iterations it spawned + renders.
 *   - Cost accounting uses the same lib/cost.ts price table the server
 *     authoritatively logs to usage_log — the meter mirrors the server
 *     within rounding, becomes exact when the iteration's terminal
 *     event lands.
 *   - When the user switches sources mid-explore, our spawned
 *     iterations leave the store (canvas iterations[] is source-scoped).
 *     We detect this via currentSourceId change + show a banner
 *     "Switched to a different source — close to return".
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, Wand2, X } from "lucide-react";

import { useImageUrl } from "@/hooks/useImageUrl";
import { useIterations } from "@/hooks/useIterations";
import {
  useCanvas,
  type Iteration,
  type ModelTier,
  type StylePainting,
} from "@/stores/canvas";
import { pricePerImage, varyPricePerImage } from "@/lib/cost";
import { Tile } from "./Tile";
import { StyleAttributionThumb } from "./StyleAttributionThumb";

type BatchChoice = 9 | 18 | "keep";
type SheetState = "idle" | "running" | "done";

/** Pixels before grid bottom that triggers the IntersectionObserver to
 *  fire the next Keep-going triplet. Slightly larger than the typical
 *  viewport height so the user perceives the next batch as continuous
 *  with the existing scroll. */
const KEEP_GOING_PREFETCH_PX = 600;

/** Triplet size for Keep-going mode. Per the plan: small enough that
 *  Stop's cost-floor stays low ($0.20 for Flash 1K × 3), large enough
 *  that the user doesn't see batches every scroll-step. */
const KEEP_GOING_BATCH = 3;

/** Fisher-Yates shuffle (non-mutating). */
function shuffle<T>(arr: ReadonlyArray<T>): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Small square thumb used in the header (source) and in the preview row. */
function ThumbSquare({
  inputKey,
  size,
  alt,
}: {
  inputKey: string;
  size: number;
  alt: string;
}) {
  const { url } = useImageUrl(inputKey);
  return (
    <div
      style={{ width: size, height: size }}
      className="relative shrink-0 overflow-hidden rounded-md ring-1 ring-hairline/60"
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bloom-warm" aria-hidden />
      )}
    </div>
  );
}

export function ExploreSheet() {
  const open = useCanvas((s) => s.exploreSheetOpen);
  const setOpen = useCanvas((s) => s.setExploreSheetOpen);
  const sources = useCanvas((s) => s.sources);
  const currentSourceId = useCanvas((s) => s.currentSourceId);
  const stylePaintings = useCanvas((s) => s.stylePaintings);
  // Reading the entire iterations array is the only way to project the
  // spawned-iteration subset live — the sheet aggregates tile state +
  // status across N iterations spawned this session.
  const iterations = useCanvas((s) => s.iterations);
  const lightboxTileId = useCanvas((s) => s.lightboxTileId);
  const lightboxSnapshot = useCanvas((s) => s.lightboxSnapshot);

  const { generate } = useIterations();

  // Local Idle-state UI. See v2.2 docstring rationale.
  const [modelTier, setModelTier] = useState<ModelTier>("flash");
  // v5.6 "Her colors" switch — ON keeps the sketch's palette and takes
  // only texture/brushwork from the reference (keep-source-colors
  // directive variant per engine family). Sticky within the session
  // like the tier toggle; default OFF = the original directive.
  const [keepHerColors, setKeepHerColors] = useState(false);
  const [batchChoice, setBatchChoice] = useState<BatchChoice>(9);
  const [state, setState] = useState<SheetState>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  // Iteration ids spawned during this session — read live from the
  // canvas store to project status + tiles.
  const [spawnedIterationIds, setSpawnedIterationIds] = useState<string[]>([]);
  // Style ids already used across all spawned iterations (set of strings
  // for O(1) exclusion when sampling the next batch).
  const [usedStyleIds, setUsedStyleIds] = useState<Set<string>>(new Set());
  // True after the user taps Stop. Gates Keep-going's auto-fire and the
  // bounded-mode "Generate N more" path. In-flight tiles in the current
  // iteration are NOT canceled — they finish (already paid).
  const [userStopped, setUserStopped] = useState(false);
  // True while a generate() call is in flight (we await the route's
  // response which contains the new iterationId). Gates Keep-going's
  // observer so we never fire two batches concurrently.
  const [batchInFlight, setBatchInFlight] = useState(false);
  // Ref mirror of batchInFlight, kept in sync inside fireBatch. The
  // IntersectionObserver callback closes over the EFFECT's snapshot of
  // `batchInFlight` at attach time, so without the ref a rapid sequence
  // of scroll → intersection → fire could race a still-pending state
  // update (the React render loop hasn't committed setBatchInFlight(true)
  // yet, so the observer's closure sees `false` and fires again).
  // fireBatch itself reads the ref as a first-line guard.
  const batchInFlightRef = useRef(false);
  // Monthly-cap state. Cleared on every Start; populated by the 429
  // response. Once set, banner sticks + Stop auto-fires.
  const [capState, setCapState] = useState<{
    currentUsd: number;
    capUsd: number;
  } | null>(null);
  // Source-switched banner: tracks the sourceId at sheet-open so a
  // change mid-explore flips the banner on.
  const openedSourceIdRef = useRef<string | null>(null);
  // Scroll container for the result grid — used as the
  // IntersectionObserver root in Keep-going mode.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sentinel element at the bottom of the grid; the observer fires when
  // it scrolls into view + the prefetch margin.
  const sentinelRef = useRef<HTMLDivElement>(null);

  // ---- derived state ---------------------------------------------------

  // Spawned iterations, in spawn order (oldest first → so the grid
  // grows downward).
  const spawnedIterations: Iteration[] = useMemo(() => {
    if (spawnedIterationIds.length === 0) return [];
    const byId = new Map(iterations.map((it) => [it.id, it]));
    return spawnedIterationIds
      .map((id) => byId.get(id))
      .filter((it): it is Iteration => it !== undefined);
  }, [iterations, spawnedIterationIds]);

  // All tiles across spawned iterations, flat, in (iteration, idx) order.
  // Used to compute the cost meter + render the grid.
  const allTiles = useMemo(
    () => spawnedIterations.flatMap((it) => it.tiles),
    [spawnedIterations],
  );

  // Number of tiles that have terminated (done/blocked/failed).
  // pendingTiles vs terminalTiles tells us whether the current run is
  // still streaming.
  const terminalTileCount = allTiles.filter(
    (t) => t.status !== "pending",
  ).length;
  const successfulTileCount = allTiles.filter(
    (t) => t.status === "done",
  ).length;
  const anyPending = allTiles.some((t) => t.status === "pending");

  // Spent so far. Authoritative pricing lives in lib/cost.ts. Each
  // iteration's tier may differ (the sheet's tier toggle locks per Start
  // tap; subsequent Generate-9-more uses the current toggle's value).
  // So we compute per-iteration and sum.
  const spentUsd = useMemo(
    () =>
      spawnedIterations.reduce(
        (sum, it) =>
          sum +
          // Sheet-spawned iterations are always Gemini (flash/pro) —
          // the 'flux' branch is a type-level guard so the EngineTier
          // union can't reach the Gemini price matrix.
          (it.modelTier === "flux"
            ? varyPricePerImage()
            : pricePerImage(it.modelTier, it.resolution)) *
            it.tiles.filter((t) => t.status === "done").length,
        0,
      ),
    [spawnedIterations],
  );

  // Source switched mid-explore: openedSourceIdRef.current was set on
  // open; currentSourceId differs now → switched. The sheet's spawned
  // iterations are gone from the store (iterations[] is source-scoped).
  const sourceSwitched =
    openedSourceIdRef.current !== null &&
    openedSourceIdRef.current !== currentSourceId;

  // ---- helpers ---------------------------------------------------------

  /** Sample up to `n` style ids excluding `usedStyleIds`. Returns
   *  fewer than `n` when the library is exhausted. */
  const sampleStyles = useCallback(
    (n: number): string[] => {
      const available = stylePaintings.filter(
        (sp) => !usedStyleIds.has(sp.id),
      );
      return shuffle(available)
        .slice(0, n)
        .map((sp) => sp.id);
    },
    [stylePaintings, usedStyleIds],
  );

  /** Fire one batch with the given style ids. Handles cap-banner state,
   *  spawned-iteration tracking, and batchInFlight gating.
   *
   *  Ref guard makes this idempotent against concurrent callers — the
   *  IntersectionObserver in Keep-going mode can fire multiple times in
   *  rapid succession before React commits a setBatchInFlight(true), so
   *  the closure-captured `batchInFlight` would read stale and the
   *  observer could double-fire. The ref captures the synchronous truth. */
  const fireBatch = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      if (batchInFlightRef.current) return false; // concurrent-call guard
      batchInFlightRef.current = true;
      setBatchInFlight(true);
      try {
        const result = await generate({
          mode: "style_explore",
          stylePaintingIds: ids,
          modelTier,
          resolution: "1k",
          keepSourceColors: keepHerColors,
        });
        if (!result) {
          // v4.6: null now means a NON-cap failure (generate rethrows
          // the monthly-cap rejection so the catch below can parse it —
          // pre-v4.6 that catch was dead code and the cap banner never
          // fired). The hook already recorded the specific error.
          setStartError("Couldn't start a batch — see error below.");
          return false;
        }
        setSpawnedIterationIds((prev) => [...prev, result.iterationId]);
        setUsedStyleIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.add(id);
          return next;
        });
        return true;
      } catch (e) {
        // The /api/iterate 429 surfaces here. The hook re-throws
        // `Monthly cap reached: $X.XX / $YY` — parse it for the banner.
        const msg = e instanceof Error ? e.message : String(e);
        const match = msg.match(/\$([\d.]+)\s*\/\s*\$([\d.]+)/);
        if (msg.includes("Monthly cap reached") && match) {
          setCapState({
            currentUsd: Number(match[1]),
            capUsd: Number(match[2]),
          });
          setUserStopped(true); // auto-stop the loop
        } else {
          setStartError(msg);
        }
        return false;
      } finally {
        batchInFlightRef.current = false;
        setBatchInFlight(false);
      }
    },
    [generate, modelTier, keepHerColors],
  );

  // ---- lifecycle effects ----------------------------------------------

  // Reset all session state on sheet OPEN — only on the closed→open
  // transition, NOT on currentSourceId changes mid-open. The earlier
  // version had `[open, currentSourceId]` deps and was re-firing on
  // source switches, which clobbered spawnedIterationIds + rewrote
  // openedSourceIdRef.current to match the new currentSourceId. That
  // made `sourceSwitched` (derived below) always-false after a switch,
  // so the user never saw the "Switched to a different source" banner
  // AND lost all in-flight tracking. The prevOpenRef gates the reset
  // strictly on the open transition so currentSourceId changes don't
  // re-fire it. (Don't reset modelTier / batchChoice — let them be
  // sticky within the session, matching the InputBar's tier
  // stickiness pattern.)
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      openedSourceIdRef.current = currentSourceId;
      setState("idle");
      setStartError(null);
      setSpawnedIterationIds([]);
      setUsedStyleIds(new Set());
      setUserStopped(false);
      setBatchInFlight(false);
      setCapState(null);
    }
    prevOpenRef.current = open;
    // currentSourceId is intentionally NOT in the deps — only `open`
    // transitions reset state; currentSourceId divergence is detected
    // by the `sourceSwitched` derivation comparing the seeded ref to
    // the live value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // State machine driver. Reacts to allTiles + batchInFlight +
  // userStopped + state to decide the next sheet state.
  useEffect(() => {
    if (state === "idle") return;
    if (state === "running") {
      // Still streaming → stay running.
      if (anyPending || batchInFlight) return;
      // All tiles terminal + no batch in flight → move to done.
      setState("done");
      return;
    }
    // 'done': no transition out — user must tap Generate-more / Start /
    // Close. The done→running transition happens inside the click
    // handler.
  }, [state, anyPending, batchInFlight]);

  // Keep-going IntersectionObserver. Attaches only in running state with
  // batchChoice='keep' + no user stop + library not exhausted.
  useEffect(() => {
    if (state !== "running") return;
    if (batchChoice !== "keep") return;
    if (userStopped) return;
    if (capState) return;
    if (sourceSwitched) return;
    const remaining = stylePaintings.length - usedStyleIds.size;
    if (remaining <= 0) return;
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (!visible) return;
        if (batchInFlight) return;
        if (anyPending) return; // wait for current batch to finish before firing next
        const ids = sampleStyles(KEEP_GOING_BATCH);
        if (ids.length === 0) return;
        void fireBatch(ids);
      },
      {
        root,
        // Negative bottom rootMargin = sentinel triggers BEFORE it
        // visually enters the viewport. ~600px above bottom feels
        // continuous with normal scrolling.
        rootMargin: `0px 0px ${KEEP_GOING_PREFETCH_PX}px 0px`,
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    state,
    batchChoice,
    userStopped,
    capState,
    sourceSwitched,
    batchInFlight,
    anyPending,
    stylePaintings.length,
    usedStyleIds.size,
    sampleStyles,
    fireBatch,
  ]);

  // Esc-to-close (defers to lightbox).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (lightboxTileId !== null || lightboxSnapshot !== null) return;
      if (e.key !== "Escape") return;
      // v4.6: close is ALWAYS allowed, including mid-batch. The old
      // batchInFlight gate turned a hung POST into a locked-shut z-50
      // modal (X, Esc, and scrim all disabled) covering the whole app
      // until a reload. Closing mid-flight is semantically fine — the
      // iteration already exists server-side and its tiles stream into
      // the regular Studio TileStream.
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, lightboxTileId, lightboxSnapshot]);

  if (!open) return null;

  const currentSource = sources.find((s) => s.sourceId === currentSourceId);
  const libCount = stylePaintings.length;
  const remainingStyles = libCount - usedStyleIds.size;
  // Bounded-mode batch size resolves to a number.
  const numericBatch: number =
    batchChoice === "keep"
      ? Math.min(9, remainingStyles)
      : Math.min(batchChoice, remainingStyles);
  // 1K only in v2.2/v2.3; cost preview reflects that.
  const projectedCost = pricePerImage(modelTier, "1k") * numericBatch;

  // ---- handlers --------------------------------------------------------

  const onStart = async () => {
    if (batchInFlight) return;
    if (libCount === 0 || !currentSource) return;
    setStartError(null);
    setUserStopped(false);
    setCapState(null);
    const initialBatchSize =
      batchChoice === "keep" ? Math.min(9, libCount) : Math.min(batchChoice, libCount);
    const ids = sampleStyles(initialBatchSize);
    setState("running");
    const ok = await fireBatch(ids);
    if (!ok) {
      // Couldn't even start — revert to idle. cap banner / error stays.
      setState("idle");
    }
  };

  const onGenerateMore = async () => {
    if (batchInFlight) return;
    if (remainingStyles <= 0) return;
    setStartError(null);
    setUserStopped(false);
    const n =
      batchChoice === "keep" ? Math.min(9, remainingStyles) : Math.min(batchChoice, remainingStyles);
    const ids = sampleStyles(n);
    setState("running");
    await fireBatch(ids);
  };

  const onStop = () => {
    setUserStopped(true);
    // If all in-flight tiles are already terminal, snap to done now.
    // Otherwise the state-machine effect will flip us to done when the
    // last in-flight tile lands.
    if (!anyPending && !batchInFlight) setState("done");
  };

  // ---- render ----------------------------------------------------------

  // Empty + no-source edge cases (defensive — InputBar's button disables
  // these). Renders Idle-state empty CTA in both cases.
  const isEmpty = libCount === 0;
  const noSource = !currentSource;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Explore styles"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className={[
          "w-full max-w-[960px] flex-col",
          "rounded-2xl border border-hairline bg-background",
          "shadow-2xl",
          "flex",
        ].join(" ")}
        style={{
          maxHeight:
            "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2rem)",
        }}
      >
        {/* HEADER */}
        <header className="flex items-start gap-4 border-b border-hairline px-5 py-4">
          {currentSource ? (
            <ThumbSquare
              inputKey={currentSource.inputKey}
              size={64}
              alt="Current source"
            />
          ) : (
            <div className="h-16 w-16 shrink-0 rounded-md bg-secondary" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-2xl tracking-tight text-foreground">
              {state === "idle"
                ? "Explore styles"
                : state === "running"
                  ? "Exploring styles"
                  : "Stopped"}
            </h2>
            <p className="mt-1 caption-display text-sm text-text-mute">
              {isEmpty
                ? "Your style library is empty."
                : state === "idle"
                  ? `${libCount} ${libCount === 1 ? "painting" : "paintings"} in your library`
                  : `${terminalTileCount} of ${allTiles.length} tiles${
                      anyPending ? " painting…" : " done"
                    } · ${remainingStyles} ${
                      remainingStyles === 1 ? "style" : "styles"
                    } left to explore`}
            </p>
          </div>
          {/* v5.6.1: "Her colors" lives in the HEADER so it's visible
              and flippable in every sheet state — the first placement
              (idle footer) vanished after the first batch of a session
              and Jeff couldn't find it. Applies to the NEXT batch
              fired ("Generate more" included). */}
          {!isEmpty && (
            <button
              type="button"
              onClick={() => setKeepHerColors(!keepHerColors)}
              aria-pressed={keepHerColors}
              title={
                keepHerColors
                  ? "Her colors ON — palette stays from her sketch; the style brings texture and brushwork only."
                  : "Her colors OFF — the style reference brings its colors AND its texture."
              }
              className={[
                "mt-1 inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5",
                "text-xs uppercase tracking-[0.18em] no-callout transition-colors",
                keepHerColors
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-hairline bg-card text-text-mute hover:text-foreground",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "h-2 w-2 rounded-full transition-colors",
                  keepHerColors ? "bg-accent" : "bg-hairline",
                ].join(" ")}
              />
              Her colors
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={[
              "rounded-full p-2 transition-colors no-callout",
              "text-text-mute hover:text-foreground hover:bg-secondary",
            ].join(" ")}
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </header>

        {/* CAP + SOURCE-SWITCH BANNERS — sticky between header + body */}
        {capState && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-5 py-2.5 text-xs text-destructive">
            Monthly cap reached: ${capState.currentUsd.toFixed(2)} of $
            {capState.capUsd.toFixed(0)}. No more batches will fire.
            {successfulTileCount > 0 && (
              <> Tiles already generated are saved.</>
            )}
          </div>
        )}
        {sourceSwitched && !capState && (
          <div className="border-b border-hairline bg-secondary/40 px-5 py-2.5 text-xs text-text-mute">
            Switched to a different source — close this sheet to see results in
            that stream.
          </div>
        )}

        {/* BODY */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 py-5"
        >
          {state === "idle" ? (
            <IdleBody
              isEmpty={isEmpty}
              noSource={noSource}
              stylePaintings={stylePaintings}
              onOpenLibrary={() => {
                setOpen(false);
                useCanvas.getState().setStylesPanelOpen(true);
              }}
            />
          ) : (
            <RunningBody
              spawnedIterations={spawnedIterations}
              sourceAspectRatio={currentSource?.aspectRatio ?? "1:1"}
              sentinelRef={sentinelRef}
            />
          )}
        </div>

        {/* FOOTER */}
        {state === "idle" && !isEmpty && !noSource && (
          <IdleFooter
            modelTier={modelTier}
            setModelTier={setModelTier}
            batchChoice={batchChoice}
            setBatchChoice={setBatchChoice}
            libCount={libCount}
            numericBatch={numericBatch}
            projectedCost={projectedCost}
            startError={startError}
            batchInFlight={batchInFlight}
            onStart={() => void onStart()}
          />
        )}

        {state === "running" && (
          <RunningFooter
            spentUsd={spentUsd}
            terminalTileCount={terminalTileCount}
            allTileCount={allTiles.length}
            userStopped={userStopped}
            onStop={onStop}
          />
        )}

        {state === "done" && (
          <DoneFooter
            spentUsd={spentUsd}
            userStopped={userStopped}
            remainingStyles={remainingStyles}
            capState={capState}
            batchInFlight={batchInFlight}
            onGenerateMore={() => void onGenerateMore()}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Subcomponents — kept inside this module since they're tightly coupled
// to the sheet's state machine. Splitting them across files would only
// add import churn without independent reuse value.
// =====================================================================

function IdleBody({
  isEmpty,
  noSource,
  stylePaintings,
  onOpenLibrary,
}: {
  isEmpty: boolean;
  noSource: boolean;
  stylePaintings: StylePainting[];
  onOpenLibrary: () => void;
}) {
  // Preview row reshuffles per render — fine since IdleBody only renders
  // while idle (no SSE churn). Keep it inside useMemo so the shuffle is
  // stable for the duration of the idle state.
  const previewThumbs = useMemo(
    () => shuffle(stylePaintings).slice(0, 6),
    [stylePaintings],
  );

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <p className="font-display text-lg italic text-text-mute">
          Add paintings to your style library first.
        </p>
        <button
          type="button"
          onClick={onOpenLibrary}
          className={[
            "rounded-md px-4 py-2",
            "border border-accent/60 bg-accent/10",
            "text-sm font-medium text-accent hover:bg-accent/15",
            "transition-colors no-callout",
          ].join(" ")}
        >
          Open style library
        </button>
      </div>
    );
  }
  if (noSource) {
    return (
      <p className="caption-display py-8 text-center text-sm italic text-text-mute">
        Pick a source first.
      </p>
    );
  }
  return (
    <>
      <p className="caption-display text-xs uppercase tracking-[0.18em] text-text-mute">
        From your library
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {previewThumbs.map((sp) => (
          <ThumbSquare
            key={sp.id}
            inputKey={sp.inputKey}
            size={64}
            alt={sp.title ?? "Style painting"}
          />
        ))}
      </div>
      <p className="mt-4 caption-display text-xs text-text-mute italic">
        Each tile is your sketch rendered in one of these styles. You scan,
        favorite, and refine the directions that spark.
      </p>
    </>
  );
}

function IdleFooter({
  modelTier,
  setModelTier,
  batchChoice,
  setBatchChoice,
  libCount,
  numericBatch,
  projectedCost,
  startError,
  batchInFlight,
  onStart,
}: {
  modelTier: ModelTier;
  setModelTier: (t: ModelTier) => void;
  batchChoice: BatchChoice;
  setBatchChoice: (b: BatchChoice) => void;
  libCount: number;
  numericBatch: number;
  projectedCost: number;
  startError: string | null;
  batchInFlight: boolean;
  onStart: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-4">
      {/* Tier */}
      <div
        role="group"
        aria-label="Model tier"
        className="inline-flex rounded-full border border-hairline bg-card p-0.5"
      >
        {(["flash", "pro"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setModelTier(t)}
            className={[
              "rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em] no-callout transition-colors",
              modelTier === t
                ? "bg-secondary text-foreground"
                : "text-text-mute hover:text-foreground",
            ].join(" ")}
            aria-pressed={modelTier === t}
          >
            {t === "flash" ? "Flash" : "Pro"}
          </button>
        ))}
      </div>
      {/* Batch — 9 | 18 | Keep going */}
      <div
        role="group"
        aria-label="Batch size"
        className="inline-flex rounded-full border border-hairline bg-card p-0.5"
      >
        {([9, 18, "keep"] as const).map((n) => {
          const disabled = typeof n === "number" && n > libCount;
          const active = batchChoice === n;
          return (
            <button
              key={String(n)}
              type="button"
              onClick={() => setBatchChoice(n)}
              disabled={disabled}
              className={[
                "rounded-full px-3 py-1 text-xs tabular-nums no-callout transition-colors",
                active
                  ? "bg-secondary text-foreground"
                  : "text-text-mute hover:text-foreground",
                disabled && "opacity-40 cursor-not-allowed",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-pressed={active}
              title={
                disabled
                  ? `You only have ${libCount} styles — first batch uses all of them.`
                  : n === "keep"
                    ? "Auto-fires triplets as you scroll. Stop button halts between batches."
                    : undefined
              }
            >
              {n === "keep" ? "Keep going" : n}
            </button>
          );
        })}
      </div>
      {/* Cost preview */}
      <span className="text-xs text-text-mute tabular-nums">
        {batchChoice === "keep" ? (
          <>
            first batch{" "}
            <span className="text-foreground">
              ${projectedCost.toFixed(2)}
            </span>{" "}
            ({numericBatch} × ${pricePerImage(modelTier, "1k").toFixed(3)}) ·
            more on scroll
          </>
        ) : (
          <>
            up to{" "}
            <span className="text-foreground">
              ${projectedCost.toFixed(2)}
            </span>{" "}
            ({numericBatch} × ${pricePerImage(modelTier, "1k").toFixed(3)})
          </>
        )}
      </span>
      <div className="ml-auto flex items-center gap-3">
        {startError && (
          <span className="max-w-[200px] truncate text-xs text-destructive">
            {startError}
          </span>
        )}
        <button
          type="button"
          onClick={onStart}
          disabled={batchInFlight}
          className={[
            "inline-flex items-center gap-2 rounded-full",
            "px-5 py-2 text-sm font-medium no-callout",
            "bg-accent text-accent-foreground",
            "transition-opacity",
            batchInFlight ? "opacity-60 cursor-wait" : "hover:opacity-90",
          ].join(" ")}
        >
          {batchInFlight ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
              Starting…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" strokeWidth={1.5} />
              Start
            </>
          )}
        </button>
      </div>
    </footer>
  );
}

function RunningBody({
  spawnedIterations,
  sourceAspectRatio,
  sentinelRef,
}: {
  spawnedIterations: Iteration[];
  sourceAspectRatio: string;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (spawnedIterations.length === 0) {
    return (
      <p className="caption-display py-8 text-center text-sm italic text-text-mute">
        Spinning up the first batch…
      </p>
    );
  }
  return (
    <>
      {/* Flat 3-col grid across all spawned iterations. The visual unit
          is the tile, not the iteration — discovery is about scanning
          many style results at a glance, so we deliberately flatten
          the per-iteration grouping. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {spawnedIterations.flatMap((it) =>
          it.tiles.map((tile) => (
            <div key={tile.id} className="flex flex-col">
              <Tile
                tile={tile}
                aspectRatio={sourceAspectRatio}
                optimistic={tile.id.startsWith(`${it.id}-`)}
              />
              {tile.stylePaintingId && (
                <StyleAttributionThumb
                  stylePaintingId={tile.stylePaintingId}
                />
              )}
            </div>
          )),
        )}
      </div>
      {/* IntersectionObserver sentinel. Always rendered while running so
          the observer in Keep-going mode has something to observe; it's
          a 1px element with no visible content. */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
    </>
  );
}

function RunningFooter({
  spentUsd,
  terminalTileCount,
  allTileCount,
  userStopped,
  onStop,
}: {
  spentUsd: number;
  terminalTileCount: number;
  allTileCount: number;
  userStopped: boolean;
  onStop: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-4">
      <span className="text-sm tabular-nums">
        Spent{" "}
        <span className="font-medium text-foreground">
          ${spentUsd.toFixed(2)}
        </span>{" "}
        <span className="text-text-mute">
          · {terminalTileCount} of {allTileCount} done
        </span>
      </span>
      <div className="ml-auto">
        <button
          type="button"
          onClick={onStop}
          disabled={userStopped}
          className={[
            "inline-flex items-center gap-2 rounded-full",
            "px-5 py-2 text-sm font-medium no-callout",
            "border border-destructive/40 bg-destructive/10 text-destructive",
            "transition-opacity",
            userStopped
              ? "opacity-50 cursor-not-allowed"
              : "hover:bg-destructive/15",
          ].join(" ")}
        >
          {userStopped ? "Stopping…" : "Stop"}
        </button>
      </div>
    </footer>
  );
}

function DoneFooter({
  spentUsd,
  userStopped,
  remainingStyles,
  capState,
  batchInFlight,
  onGenerateMore,
  onClose,
}: {
  spentUsd: number;
  userStopped: boolean;
  remainingStyles: number;
  capState: { currentUsd: number; capUsd: number } | null;
  batchInFlight: boolean;
  onGenerateMore: () => void;
  onClose: () => void;
}) {
  const exhausted = remainingStyles <= 0;
  // Disable Generate more if: user stopped, cap hit, library exhausted,
  // or a batch is currently in flight.
  const canGenerateMore =
    !userStopped && !capState && !exhausted && !batchInFlight;
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-4">
      <span className="text-sm tabular-nums">
        {userStopped ? "Stopped at " : "Spent "}
        <span className="font-medium text-foreground">
          ${spentUsd.toFixed(2)}
        </span>
        {exhausted && (
          <span className="text-text-mute">
            {" "}
            · explored every style in your library
          </span>
        )}
      </span>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={onGenerateMore}
          disabled={!canGenerateMore}
          className={[
            "inline-flex items-center gap-2 rounded-full",
            "px-4 py-2 text-sm font-medium no-callout",
            "border border-hairline bg-card text-foreground",
            "transition-opacity",
            !canGenerateMore
              ? "opacity-50 cursor-not-allowed"
              : "hover:bg-secondary",
          ].join(" ")}
          title={
            exhausted
              ? "Add more styles in the library to keep exploring."
              : userStopped
                ? "You stopped this session — close and re-open to start fresh."
                : capState
                  ? "Monthly cap reached."
                  : undefined
          }
        >
          Generate 9 more
        </button>
        <button
          type="button"
          onClick={onClose}
          className={[
            "inline-flex items-center gap-2 rounded-full",
            "px-5 py-2 text-sm font-medium no-callout",
            "bg-accent text-accent-foreground hover:opacity-90",
          ].join(" ")}
        >
          Close
        </button>
      </div>
    </footer>
  );
}
