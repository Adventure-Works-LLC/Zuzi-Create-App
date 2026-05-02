/**
 * In-process pub/sub keyed by iteration id, used by SSE handlers and the worker.
 *
 * SINGLE-INSTANCE ONLY — see AGENTS.md §1. The Map lives in this process; horizontal
 * scaling would silently drop events for subscribers on other replicas. Plan §Hosting
 * pins Railway Hobby (single instance), so this assumption holds for v1.
 *
 * Buffer-free: subscribers MUST query the DB for current state before subscribing if
 * they need replay. The SSE handler in `app/api/iterate/[id]/stream/route.ts` does this
 * (subscribe-first → DB query → dedupe by `(idx, status)`).
 */

import { EventEmitter } from "node:events";

export type IterEvent =
  | { type: "started" }
  | {
      type: "tile";
      /** Canonical `tiles.id` (ulid) — needed by the client so the favorite
       * endpoint receives a real id rather than a synthetic placeholder. */
      id: string;
      idx: number;
      status: "done" | "blocked" | "failed";
      outputKey?: string;
      thumbKey?: string;
      error?: string;
    }
  | { type: "done" };

const emitters = new Map<string, EventEmitter>();

function getEmitter(iterId: string): EventEmitter {
  let em = emitters.get(iterId);
  if (!em) {
    em = new EventEmitter();
    // 10 is enough headroom for the realistic worst case (1 SSE subscriber per
    // iteration, with at most a handful of in-flight iterations per tab + one
    // shared in-process worker). Anything past 10 is almost certainly a leak;
    // letting Node's MaxListenersExceededWarning fire surfaces it quickly
    // instead of the previous value of 50 silently absorbing it.
    em.setMaxListeners(10);
    emitters.set(iterId, em);
  }
  return em;
}

export function emit(iterId: string, ev: IterEvent): void {
  getEmitter(iterId).emit("ev", ev);
  // After "done", drop the emitter so memory doesn't grow unboundedly. Late-arriving
  // subscribers will fall back to the DB replay path.
  if (ev.type === "done") {
    // Disposal is deferred via queueMicrotask as a small optimization that
    // shrinks the window in which a subscriber attaching in the same tick as
    // the `done` emit still gets a live emitter to listen on. It is NOT what
    // makes correctness hold — the actual safety net for late subscribers
    // lives in the SSE route at `app/api/iterate/[id]/stream/route.ts`: after
    // calling `bus.subscribe(...)`, that handler queries the DB and checks
    // `iter.status === 'done' || 'failed'` to send `done` and close out
    // immediately for iterations that already finished. So even if disposal
    // happened synchronously here, the DB-replay branch would catch the case
    // where a subscriber arrived too late to hear the live emit. The
    // microtask defer just trims the window in which that path needs to fire.
    queueMicrotask(() => {
      const em = emitters.get(iterId);
      if (em) {
        em.removeAllListeners();
        emitters.delete(iterId);
      }
    });
  }
}

/** Returns an `unsubscribe` function. */
export function subscribe(
  iterId: string,
  handler: (ev: IterEvent) => void,
): () => void {
  const em = getEmitter(iterId);
  const wrapped = (ev: IterEvent) => handler(ev);
  em.on("ev", wrapped);
  return () => {
    em.off("ev", wrapped);
  };
}
