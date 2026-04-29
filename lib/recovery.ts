/**
 * Recovery log — append-only JSONL on the Volume.
 *
 * Written by `runIteration` AFTER each successful Gemini response and BEFORE the
 * corresponding `UPDATE tiles SET status='done'`. If the process dies between R2 success
 * and the DB write, the boot sweep replays from this log so we don't pay twice for the
 * same image.
 *
 * The DB is the source of truth; this file is just the bridge for that narrow window.
 *
 * Path-tolerance: `scanAndRehydrate` parses line-by-line with try/catch and silently
 * drops the LAST line if it fails to parse (a crash mid-write leaves at most one
 * trailing partial line). Earlier malformed lines are warned but skipped.
 */

import {
  appendFile,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface RecoveryRow {
  iter_id: string;
  idx: number;
  r2_key: string;
  thumb_key?: string;
  ts: number;
}

function recoveryPath(): string {
  const dbPath = (process.env.DATABASE_URL ?? "./data/zuzi.db").replace(
    /^file:/,
    "",
  );
  // Co-locate with the DB so the same Volume mount carries both.
  return resolve(dirname(dbPath), "recovery.jsonl");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function appendRecovery(row: RecoveryRow): Promise<void> {
  const path = recoveryPath();
  await ensureDir(path);
  const line = JSON.stringify(row) + "\n";
  await appendFile(path, line, { encoding: "utf8" });
}

export interface RecoveryScan {
  rows: RecoveryRow[];
  byIterIdx: Map<string, RecoveryRow>; // key = `${iter_id}:${idx}`
  parseErrors: number;
  trailingPartialDropped: boolean;
}

export async function scanRecovery(): Promise<RecoveryScan> {
  const path = recoveryPath();
  let raw: string;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return {
        rows: [],
        byIterIdx: new Map(),
        parseErrors: 0,
        trailingPartialDropped: false,
      };
    }
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        rows: [],
        byIterIdx: new Map(),
        parseErrors: 0,
        trailingPartialDropped: false,
      };
    }
    throw e;
  }

  const lines = raw.split("\n");
  // The split produces a trailing empty string when the file ends with \n.
  // If the file ends without \n (mid-write crash), the last entry is partial.
  const trailingPartial = lines.length > 0 && lines[lines.length - 1] !== "";
  if (lines[lines.length - 1] === "") lines.pop();

  const rows: RecoveryRow[] = [];
  const byIterIdx = new Map<string, RecoveryRow>();
  let parseErrors = 0;
  let trailingPartialDropped = false;

  const lastIdx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as RecoveryRow;
      if (
        typeof parsed.iter_id !== "string" ||
        typeof parsed.idx !== "number" ||
        typeof parsed.r2_key !== "string" ||
        typeof parsed.ts !== "number"
      ) {
        if (i === lastIdx && trailingPartial) {
          trailingPartialDropped = true;
        } else {
          console.warn("[recovery] malformed row ignored:", line.slice(0, 200));
          parseErrors++;
        }
        continue;
      }
      rows.push(parsed);
      byIterIdx.set(`${parsed.iter_id}:${parsed.idx}`, parsed);
    } catch {
      if (i === lastIdx && trailingPartial) {
        trailingPartialDropped = true;
      } else {
        console.warn(
          "[recovery] unparseable row ignored:",
          line.slice(0, 200),
        );
        parseErrors++;
      }
    }
  }

  return { rows, byIterIdx, parseErrors, trailingPartialDropped };
}
