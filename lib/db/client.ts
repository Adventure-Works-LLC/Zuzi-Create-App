/**
 * SQLite + Drizzle client.
 *
 * SINGLE-INSTANCE ONLY (see AGENTS.md §1) — `better-sqlite3` opens the file
 * synchronously in this process. Horizontal scaling would require Postgres
 * (or LiteFS, but that's out of scope for v1).
 *
 * Pragmas set at boot per AGENTS.md / docs/SCHEMA.md:
 *   journal_mode = WAL          (concurrent reads while we write)
 *   synchronous  = NORMAL       (durability tradeoff for speed; fine on a Volume)
 *   foreign_keys = ON           (enforce ON DELETE CASCADE on tiles)
 *
 * `runtime = 'nodejs'` is required on every Route Handler / Proxy / instrumentation
 * file that imports this (better-sqlite3 is a native module — see AGENTS.md §2).
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL ?? "./data/zuzi.db";
  return raw.replace(/^file:/, "");
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

function init() {
  if (_db && _sqlite) return;
  const dbPath = resolveDbPath();
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("synchronous = NORMAL");
  _sqlite.pragma("foreign_keys = ON");
  _db = drizzle(_sqlite, { schema });
}

export function db() {
  if (!_db) init();
  return _db!;
}

export function sqlite() {
  if (!_sqlite) init();
  return _sqlite!;
}

export { schema };
