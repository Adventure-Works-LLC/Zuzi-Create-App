import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: (process.env.DATABASE_URL ?? "./data/zuzi.db").replace(/^file:/, ""),
  },
  strict: true,
  verbose: true,
} satisfies Config;
