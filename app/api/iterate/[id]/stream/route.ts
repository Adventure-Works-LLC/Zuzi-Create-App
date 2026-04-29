/**
 * GET /api/iterate/:id/stream — Server-Sent Events stream of tile progress.
 *
 * Subscribe-first → DB query → dedupe by `(idx, status)` (per AGENTS.md §5):
 *   1. Subscribe to the bus first so any tile that completes between query and
 *      subscribe is buffered, not dropped.
 *   2. Query the DB for current tile state and emit each non-pending tile.
 *   3. From then on, the live bus handler emits new events; the dedupe Set keeps
 *      replayed-and-then-also-broadcast events from being sent twice.
 *
 * Events:
 *   event: tile  data: {idx, status, outputKey?, thumbKey?, error?}
 *   event: done  data: {}
 *
 * Cleanup: when the client disconnects (req.signal aborts) we unsubscribe and
 * close. The `done` event closes the stream from the server side normally.
 *
 * runtime = 'nodejs' for better-sqlite3 + EventEmitter.
 */

import { getSession } from "@/lib/auth/session";
import { getIteration, tilesFor } from "@/lib/db/queries";
import * as bus from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAuthed(): Promise<boolean> {
  try {
    const session = await getSession();
    return typeof session.authedAt === "number" && session.authedAt > 0;
  } catch {
    return false;
  }
}

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return new Response("unauthenticated", { status: 401 });
  }

  const { id: iterationId } = await params;
  if (!iterationId) {
    return new Response("missing_id", { status: 400 });
  }

  const iter = getIteration(iterationId);
  if (!iter) {
    return new Response("iteration_not_found", { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const sent = new Set<string>(); // dedupe key: `${idx}:${status}`
      let closed = false;

      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed */
        }
      };

      const trySendTile = (tile: {
        idx: number;
        status: string;
        output_image_key?: string | null;
        thumb_image_key?: string | null;
        error_message?: string | null;
      }) => {
        if (tile.status === "pending") return;
        const key = `${tile.idx}:${tile.status}`;
        if (sent.has(key)) return;
        sent.add(key);
        enqueue(
          sseEncode("tile", {
            idx: tile.idx,
            status: tile.status,
            outputKey: tile.output_image_key ?? undefined,
            thumbKey: tile.thumb_image_key ?? undefined,
            error: tile.error_message ?? undefined,
          }),
        );
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // 1) Subscribe first.
      const unsubscribe = bus.subscribe(iterationId, (ev) => {
        if (ev.type === "tile") {
          trySendTile({
            idx: ev.idx,
            status: ev.status,
            output_image_key: ev.outputKey ?? null,
            thumb_image_key: ev.thumbKey ?? null,
            error_message: ev.error ?? null,
          });
        } else if (ev.type === "done") {
          enqueue(sseEncode("done", {}));
          closeStream();
        }
      });

      // Initial retry hint for the EventSource client.
      enqueue("retry: 3000\n\n");

      // 2) Query DB for current state and replay non-pending tiles.
      try {
        const tiles = tilesFor(iterationId);
        for (const t of tiles) trySendTile(t);

        // 3) If the iteration is already done, send `done` and close immediately.
        if (iter.status === "done" || iter.status === "failed") {
          enqueue(sseEncode("done", {}));
          closeStream();
          return;
        }
      } catch (e) {
        console.error(
          `[stream ${iterationId}] DB replay failed:`,
          e instanceof Error ? e.message : e,
        );
      }

      // Cleanup if the client disconnects.
      req.signal.addEventListener("abort", () => {
        closeStream();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
