-- Data-only migration: backfill `iterations.tile_count` from the actual count of
-- tile rows. Pre-pivot iterations have 9 tiles but their `tile_count` was set to
-- the new column default (3) by the 0001_dusty_kronos ALTER TABLE. This migration
-- corrects those rows so the new GET /api/iterations endpoint reports a tileCount
-- that matches the embedded tiles array.
--
-- Idempotent: running twice produces the same result. Safe against production
-- data because:
--   - It only touches rows that already have at least one tile (WHERE EXISTS).
--   - It sets tile_count to the actual count, which is a fixed property of the row
--     (tiles are never inserted post-iteration completion).
UPDATE iterations
SET tile_count = (SELECT COUNT(*) FROM tiles WHERE tiles.iteration_id = iterations.id)
WHERE EXISTS (SELECT 1 FROM tiles WHERE tiles.iteration_id = iterations.id);
