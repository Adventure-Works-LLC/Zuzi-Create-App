import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output trims the production bundle from ~260MB to ~50–80MB by
  // shipping only what `next build` traced as reachable. Devtooling stays in
  // devDependencies and never lands on Railway.
  //
  // Two consequences worth pinning:
  //   1. `scripts/migrate.ts` (TS, requires `tsx` devDep) is NOT in the
  //      runtime image. Migrations run from `instrumentation.ts` instead,
  //      using production deps only (`drizzle-orm/better-sqlite3/migrator`).
  //   2. Files referenced at runtime that aren't in the JS module graph —
  //      e.g. the SQL files under `drizzle/` — wouldn't be copied without
  //      `outputFileTracingIncludes` below. They're read by the migrator
  //      via `migrationsFolder: "./drizzle"`.
  output: "standalone",
  outputFileTracingIncludes: {
    "/": ["./drizzle/**/*"],
  },
  // The tracer follows literal path strings it sees in code (e.g. the
  // `"./data/zuzi.db"` default in `lib/db/client.ts`) and pulls everything
  // under `./data/` into the standalone bundle. Locally that's the working
  // SQLite file, the WAL, and `recovery.jsonl` from prior smoke runs — none
  // of which should land in production. Same for repo-only directories that
  // happen to contain heavy or sensitive content (samples, agent worktrees,
  // local /tmp scratch). Listing them here keeps standalone output clean.
  outputFileTracingExcludes: {
    "/": [
      "data/**/*",
      "samples/**/*",
      ".claude/**/*",
      "tmp/**/*",
    ],
  },
};

export default nextConfig;
