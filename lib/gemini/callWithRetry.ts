/**
 * Retry wrapper for Gemini API calls.
 *
 * 1 initial attempt + 3 retries = 4 total. Backoff schedule on retries: 2s, 5s, 12s
 * ± jitter (up to ±500ms). Retries on HTTP 429 / 500 / 503, plus transient network
 * classifications from `lib/gemini/errors.ts` (network / timeout / quota).
 *
 * Other errors (auth, safety, unknown 4xx) are re-thrown immediately — there's no
 * point retrying a forbidden API key or a content-policy block.
 */

import { classifyError } from "./errors";

interface Options {
  attempts?: number;
  retryOn?: number[];
  label?: string;
}

const DEFAULT_DELAYS_MS = [2_000, 5_000, 12_000] as const;
const DEFAULT_RETRY_STATUSES = [429, 500, 503];
const RETRYABLE_CLASSIFICATIONS = new Set([
  "network",
  "timeout",
  "quota",
] as const);

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 500);
}

function statusFromError(err: unknown): number | undefined {
  const e = err as
    | { status?: number; statusCode?: number; cause?: { status?: number } }
    | undefined;
  if (!e) return undefined;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (e.cause && typeof e.cause.status === "number") return e.cause.status;
  return undefined;
}

function shouldRetry(err: unknown, retryOn: number[]): boolean {
  const status = statusFromError(err);
  if (status !== undefined && retryOn.includes(status)) return true;
  const classified = classifyError(err);
  if (RETRYABLE_CLASSIFICATIONS.has(classified.classification as never))
    return true;
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: Options = {},
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_DELAYS_MS.length + 1;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_STATUSES;
  const label = opts.label ?? "gemini";

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(e, retryOn)) {
        throw e;
      }
      const delayMs = jitter(
        DEFAULT_DELAYS_MS[Math.min(i, DEFAULT_DELAYS_MS.length - 1)],
      );
      const status = statusFromError(e);
      console.warn(
        `[callWithRetry:${label}] attempt ${i + 1}/${attempts} failed (status=${status ?? "?"}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  // Unreachable, but keeps TS happy.
  throw lastErr;
}
