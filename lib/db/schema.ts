/**
 * Drizzle schema. MUST match docs/SCHEMA.md exactly — column names, types, indices.
 *
 * If the schema needs to change:
 *   1. Update docs/SCHEMA.md FIRST.
 *   2. Update this file to match.
 *   3. Run `npm run db:generate` to produce a new migration.
 *   4. Commit both this file and the new migration.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const iterations = sqliteTable(
  "iterations",
  {
    id: text("id").primaryKey(),
    request_id: text("request_id").notNull().unique(),
    input_image_key: text("input_image_key").notNull(),
    model_tier: text("model_tier", { enum: ["flash", "pro"] })
      .notNull()
      .default("pro"),
    resolution: text("resolution", { enum: ["1k", "4k"] })
      .notNull()
      .default("1k"),
    status: text("status", {
      enum: ["pending", "running", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    created_at: integer("created_at").notNull(),
    completed_at: integer("completed_at"),
  },
  (t) => [
    index("idx_iter_created").on(t.created_at),
    index("idx_iter_input_image").on(t.input_image_key, t.created_at),
  ],
);

export const tiles = sqliteTable(
  "tiles",
  {
    id: text("id").primaryKey(),
    iteration_id: text("iteration_id")
      .notNull()
      .references(() => iterations.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    output_image_key: text("output_image_key"),
    thumb_image_key: text("thumb_image_key"),
    status: text("status", {
      enum: ["pending", "done", "blocked", "failed"],
    })
      .notNull()
      .default("pending"),
    error_message: text("error_message"),
    is_favorite: integer("is_favorite").notNull().default(0),
    favorited_at: integer("favorited_at"),
    created_at: integer("created_at").notNull(),
    completed_at: integer("completed_at"),
  },
  (t) => [
    uniqueIndex("unique_iter_idx").on(t.iteration_id, t.idx),
    index("idx_tiles_iter").on(t.iteration_id),
    index("idx_tiles_fav")
      .on(t.is_favorite, t.favorited_at)
      .where(sql`is_favorite = 1`),
  ],
);

export const usage_log = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    iteration_id: text("iteration_id").references(() => iterations.id),
    cost_usd: real("cost_usd").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_usage_created").on(t.created_at)],
);

export type Iteration = typeof iterations.$inferSelect;
export type NewIteration = typeof iterations.$inferInsert;
export type Tile = typeof tiles.$inferSelect;
export type NewTile = typeof tiles.$inferInsert;
export type UsageLog = typeof usage_log.$inferSelect;
export type NewUsageLog = typeof usage_log.$inferInsert;
