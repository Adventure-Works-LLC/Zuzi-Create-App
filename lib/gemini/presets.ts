/**
 * Shared parser for the `iterations.presets` JSON column.
 *
 * Defense-in-depth: the API route validates user input on write, but every reader
 * (the worker, the listing endpoint, the iterate route's idempotent-replay branches)
 * re-validates on read so a malformed row (manual DB edit, bad migration, recovered
 * backup) can't crash callers. Anything unparseable or unknown is dropped silently —
 * equivalent to "freeform", which falls back to the make-this-beautiful prompt.
 *
 * `context` is an optional label (e.g. iteration id) used in the warn log, so the
 * issue surfaces in tails when present.
 */

import { PRESETS, type Preset } from "../db/schema";

export function parseStoredPresets(raw: string, context?: string): Preset[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(PRESETS);
    return parsed.filter(
      (p): p is Preset => typeof p === "string" && allowed.has(p),
    );
  } catch (e) {
    if (context) {
      console.warn(
        `[parseStoredPresets ${context}] presets JSON parse failed; falling back to freeform`,
        e instanceof Error ? e.message : e,
      );
    }
    return [];
  }
}

/**
 * Shared parser for the v3.0 `iterations.blend_tile_ids` JSON column.
 * Same defense-in-depth contract as parseStoredPresets — tolerates
 * malformed JSON / wrong shape by returning []. Empty array is the
 * canonical "not a blend iteration" signal; callers read
 * `iter.mode === 'style_blend'` for the authoritative discriminator.
 */
export function parseBlendTileIdsJson(
  raw: string,
  context?: string,
): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (context) {
        console.warn(
          `[parseBlendTileIdsJson ${context}] blend_tile_ids JSON was not an array (got ${typeof parsed}); falling back to []`,
        );
      }
      return [];
    }
    const filtered = parsed.filter(
      (v): v is string => typeof v === "string",
    );
    // Surface partial corruption: route input validation rejects
    // non-string entries up front, so this branch only fires for
    // manually-edited or backup-restored rows. Logging here makes
    // corruption visible in tails so it doesn't silently change the
    // worker's behavior.
    if (context && filtered.length !== parsed.length) {
      console.warn(
        `[parseBlendTileIdsJson ${context}] dropped ${parsed.length - filtered.length} non-string entries from blend_tile_ids; corrupted DB row?`,
      );
    }
    return filtered;
  } catch (e) {
    if (context) {
      console.warn(
        `[parseBlendTileIdsJson ${context}] blend_tile_ids JSON parse failed; falling back to []`,
        e instanceof Error ? e.message : e,
      );
    }
    return [];
  }
}
