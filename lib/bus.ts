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
    em.setMaxListeners(50); // headroom for multiple SSE connections per iteration
    emitters.set(iterId, em);
  }
  return em;
}

export function emit(iterId: string, ev: IterEvent): void {
  getEmitter(iterId).emit("ev", ev);
  // After "done", drop the emitter so memory doesn't grow unboundedly. Late-arriving
  // subscribers will fall back to the DB replay path.
  if (ev.type === "done") {
    // Defer disposal so subscribers attached during the same tick still receive it.
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
