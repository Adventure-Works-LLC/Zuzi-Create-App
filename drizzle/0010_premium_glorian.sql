-- v5.3 Pro daily fuel gauge — durable counting (AGENTS.md §4 quota notes).
--
-- The gauge first shipped counting tiles on pro iterations, which
-- undercounts as soon as Zuzi hard-deletes runs (tiles cascade away;
-- observed live: gauge said 95 the same day Google's 250/day wall
-- fired). usage_log rows SURVIVE deletes (iteration_id is nullified,
-- the row stays), so the worker now records the engine tier and the
-- number of completed calls per iteration here.
--
--   model_tier  TEXT NULL     -- 'flash' | 'pro' | 'flux'; NULL pre-0010
--   image_count INTEGER NULL  -- done + blocked tiles (completed calls;
--                             -- 429-rejected calls consume no Google
--                             -- quota and are excluded); NULL pre-0010
ALTER TABLE `usage_log` ADD `model_tier` text;--> statement-breakpoint
ALTER TABLE `usage_log` ADD `image_count` integer;
