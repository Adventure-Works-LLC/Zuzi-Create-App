-- Data-only migration: rename the 'composition' preset key to 'ambiance' in
-- existing iterations.presets JSON arrays. Composition (a reframing operation)
-- was removed in favor of Ambiance (atmospheric depth in sparse areas) — see
-- AGENTS.md §4 for the rationale.
--
-- Production has only run a few smoke iterations since 0001 added the column,
-- so this is mostly defensive. Idempotent: re-running produces the same result
-- because rows that already contain 'ambiance' won't match the WHERE clause
-- (REPLACE on a string without 'composition' is a no-op anyway).
--
-- Why REPLACE instead of full JSON parse: SQLite's REPLACE is byte-substring
-- replacement on quoted JSON strings, which is correct here because preset
-- keys are valid JSON strings with no escape sequences and 'composition' does
-- not appear as a substring of any other preset key. If preset keys ever
-- collide on substrings, switch to a JSON-aware migration.
UPDATE iterations
SET presets = REPLACE(presets, 'composition', 'ambiance')
WHERE presets LIKE '%composition%';
