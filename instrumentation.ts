/**
 * Next.js 16 instrumentation hook — runs once at server startup, before any
 * request is served.
 *
 * Order of operations:
 *   1. Apply pending Drizzle migrations. With `output: 'standalone'` enabled
 *      in next.config.ts, the `scripts/migrate.ts` runner is no longer
 *      reachable from the production runtime (it's a dev-only TS file using
 *      `tsx`, neither of which lands in `.next/standalone/`). Running the
 *      same migration call inline here uses only production dependencies
 *      (`better-sqlite3`, `drizzle-orm/better-sqlite3/migrator`), which DO
 *      ship with the standalone bundle. The drizzle/ migration files are
 *      copied into the standalone runtime via `outputFileTracingIncludes`
 *      in next.config.ts.
 *
 *      Migration failures throw — the server should not start with a stale
 *      schema. Set `SKIP_MIGRATIONS=1` to bypass (tests, ad-hoc debugging
 *      against a known-current DB).
 *
 *   2. Boot sweep — four steps, ordered (longer comment inside the
 *      register() block explains the dependencies):
 *        a. recoverStuckIterations() — FIRST. Walks every iteration in
 *           pending/running status; HEADs R2 for each pending tile's
 *           output + thumb keys; reconnects (status='done') or fails
 *           (status='failed', error_message='server_restart_recovered')
 *           per tile; rolls iteration status forward to a terminal
 *           state. Iterations whose HEADs returned a non-404 error are
 *           DEFERRED — left in pending so a later boot can retry. This
 *           is the load-bearing fix for "Railway redeploy mid-
 *           generation leaves iterations stuck forever" — the previous
 *           sweep only flipped tile status, not iteration status, and
 *           the frontend reads iteration status to decide whether to
 *           keep showing the loading animation.
 *        b. markStalePendingFailed(5min) — fallback for any tile the
 *           recovery sweep skipped (e.g., a deferred iteration whose
 *           tiles are very old). Marks them `failed` with
 *           `error_message='server_restart'` so the user can at least
 *           see something terminal.
 *        c. cleanupEmptyIterations() — reaps `done`/`failed` iteration
 *           rows whose every tile is soft-deleted (legacy data + the
 *           rare race where a worker writes zero tile rows).
 *        d. scanRecovery() — forensic logging of recovery.jsonl. Warns
 *           on parse errors / trailing-partial drops. The R2 HEAD
 *           sweep is the source of truth for reconnection now;
 *           recovery.jsonl is kept for debugging only.
 *
 * Native modules in scope (better-sqlite3, fs) — must NOT run on Edge. The
 * `NEXT_RUNTIME === 'nodejs'` check below is the standard Next 16 pattern
 * that keeps this file safely importable from anywhere.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 1) Migrations FIRST. The boot sweep below assumes the schema is current.
  if (process.env.SKIP_MIGRATIONS !== "1") {
    try {
      const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
      const { db } = await import("./lib/db/client");
      // Compute the migrations folder without `node:path`. Turbopack's static
      // analyzer flags any `node:`-prefixed import as Edge-incompatible even
      // when it's behind a runtime gate, producing a build warning. Plain
      // string concat works the same; cwd is /app inside the Docker runner
      // and the standalone server runs from there.
      const migrationsFolder = `${process.cwd()}/drizzle`;
      // db() returns a typed BetterSQLite3Database<schema>; the migrator
      // accepts any drizzle-orm-better-sqlite3 instance. The schema generic
      // doesn't affect runtime behavior; cast keeps types calm.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate(db() as any, { migrationsFolder });
      console.log(`[boot] migrations applied from ${migrationsFolder}`);
    } catch (e) {
      // Don't continue with a stale schema. Throwing here prevents Next from
      // starting the request handler — Railway will surface this as a deploy
      // failure rather than silently shipping broken queries.
      console.error(
        "[boot] migration FAILED:",
        e instanceof Error ? e.stack ?? e.message : e,
      );
      throw e;
    }
  } else {
    console.log("[boot] SKIP_MIGRATIONS=1; not applying migrations");
  }

  // 2) Boot sweep. Wrapped in try so a sweep failure doesn't crash the
  //    server — a missed sweep is recoverable; a missed migration isn't.
  //
  //    Sweep order matters:
  //      a. Stuck-iteration recovery FIRST (R2 HEAD per pending tile,
  //         reconnect or fail). Iterations that reconnect transition
  //         out of pending → tile-stale fallback below has nothing to
  //         do for them.
  //      b. markStalePendingFailed as defense-in-depth — any tile that
  //         was still pending after recovery (e.g., an R2 HEAD failed
  //         transiently and skipped the tile) gets marked failed if
  //         old enough. Iteration recovery already rolls iteration
  //         status forward, so this is mainly belt-and-suspenders.
  //      c. cleanupEmptyIterations — reaps now-orphan iteration rows
  //         (mainly useful for legacy data; stuck-recovery doesn't
  //         delete iterations, so this runs the existing cleanup).
  //      d. recovery.jsonl scan — forensic logging only.
  try {
    const { cleanupEmptyIterations, markStalePendingFailed } = await import(
      "./lib/db/queries"
    );
    const { recoverStuckIterations } = await import("./lib/stuckRecovery");
    const { scanRecovery } = await import("./lib/recovery");

    // a. Stuck-iteration recovery. Per-iteration R2 HEAD checks for the
    //    expected output + thumb keys; reconnect on hit, fail on miss.
    //    Iteration status rolls forward to a terminal state regardless
    //    of outcome — the user must always be able to reach a
    //    deletable state for any iteration that survived a redeploy.
    try {
      const recovered = await recoverStuckIterations();
      if (recovered.length > 0) {
        // One log line per iteration so we can trace recovery in the
        // wild from Railway logs.
        for (const r of recovered) {
          console.log(
            `[boot] stuckRecovery iter=${r.iterationId} outcome=${r.outcome} ` +
              `reconnected=${r.reconnectedTiles} failed=${r.failedTiles} ` +
              `status=${r.iterationStatus}`,
          );
        }
        console.log(
          `[boot] stuckRecovery: processed ${recovered.length} iteration(s)`,
        );
      }
    } catch (e) {
      console.error(
        "[boot] stuckRecovery failed (non-fatal):",
        e instanceof Error ? e.message : e,
      );
    }

    // b. Stale-tile fallback. Most tiles will already be terminal after
    //    recovery; this catches anything the recovery sweep skipped.
    const stale = markStalePendingFailed(5 * 60_000);
    if (stale > 0) {
      console.warn(
        `[boot] markStalePendingFailed: ${stale} tile(s) marked failed (server_restart)`,
      );
    }

    // c. Reap legacy empty iterations. Self-healing on every deploy.
    const empties = cleanupEmptyIterations();
    if (empties > 0) {
      console.log(
        `[boot] cleanupEmptyIterations: reaped ${empties} iteration row(s) with zero active tiles`,
      );
    }

    // d. recovery.jsonl scan — forensic logging only.
    const scan = await scanRecovery();
    if (scan.parseErrors > 0) {
      console.warn(
        `[boot] recovery.jsonl parse errors: ${scan.parseErrors}`,
      );
    }
    if (scan.trailingPartialDropped) {
      console.warn(
        `[boot] recovery.jsonl had a trailing partial line (silently dropped)`,
      );
    }
    if (scan.rows.length > 0) {
      console.log(
        `[boot] recovery.jsonl scanned: ${scan.rows.length} row(s) available for lazy rehydrate`,
      );
    }
  } catch (e) {
    console.error(
      "[boot] sweep failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
