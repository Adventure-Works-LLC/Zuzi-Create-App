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
