/**
 * Gemini API client.
 *
 * **Lazy singleton on purpose.** A previous implementation instantiated the
 * client + threw on missing `GEMINI_API_KEY` at module-evaluation time. That
 * worked under Railpack auto-detection (which injects Railway env vars into
 * the build container transparently) but broke when we moved to an explicit
 * Dockerfile — Next's page-data-collection step imports every route module
 * during build, and the throw fired before the runtime env was available.
 *
 * The pattern below matches `lib/storage/r2.ts` and `lib/db/client.ts`:
 * deferred construction inside a getter. Build-time imports of any module
 * that imports this file no longer need `GEMINI_API_KEY` to be set; only
 * actual call sites do (the worker in `runIteration.ts`, the smoke script).
 *
 * If you find yourself reaching for the eager pattern again because "it's
 * cleaner" — read the diagnosis in commit history before changing it.
 */

import { GoogleGenAI } from "@google/genai";

let _genai: GoogleGenAI | null = null;

/**
 * Returns the singleton Gemini client. Throws if `GEMINI_API_KEY` is missing
 * — but only at call time, never at module-load time. Callers are route
 * handlers / the worker / smoke, all of which run after env is loaded.
 */
export function genai(): GoogleGenAI {
  if (_genai) return _genai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Set it in .env (local) or in the Railway service env (production).",
    );
  }
  _genai = new GoogleGenAI({ apiKey });
  return _genai;
}

export const PLANNER_MODEL = "gemini-2.5-flash";
export const IMAGE_MODEL_PRO = "gemini-3-pro-image-preview";
export const IMAGE_MODEL_FLASH = "gemini-3.1-flash-image-preview";
