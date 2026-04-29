/**
 * Next.js 16 instrumentation hook — runs once at server startup.
 *
 * Boot sweep per AGENTS.md §5 Tier C item 13:
 *   1. markStalePendingFailed(5min): any tile that's been `pending` for more than 5
 *      minutes is from a previous process that died mid-flight. Mark it `failed` with
 *      `error_message='server_restart'` so subscribers don't hang forever.
 *   2. scanRecovery(): warn on parse errors / trailing-partial drops so we know the
 *      JSONL is healthy. Actual rehydration of paid-for-but-not-yet-DB-written tiles
 *      happens lazily inside `runIteration` when an iteration row is reactivated.
 *
 * Native modules in scope (better-sqlite3, fs) — must NOT run on Edge. The
 * `NEXT_RUNTIME === 'nodejs'` check below is the standard Next 16 pattern that keeps
 * this file safely importable from anywhere.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

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
    // Don't let boot sweep failures crash the server. Log loudly, continue.
    console.error("[boot] sweep failed:", e instanceof Error ? e.message : e);
  }
}
