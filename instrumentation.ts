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
 *   2. Boot sweep per AGENTS.md §5 Tier C item 13:
 *        - markStalePendingFailed(5min): any tile that's been `pending` for
 *          more than 5 minutes is from a previous process that died mid-
 *          flight. Mark it `failed` with `error_message='server_restart'`.
 *        - scanRecovery(): warn on parse errors / trailing-partial drops.
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
  try {
    const { markStalePendingFailed } = await import("./lib/db/queries");
    const { scanRecovery } = await import("./lib/recovery");

    const stale = markStalePendingFailed(5 * 60_000);
    if (stale > 0) {
      console.warn(
        `[boot] markStalePendingFailed: ${stale} tile(s) marked failed (server_restart)`,
      );
    }

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
