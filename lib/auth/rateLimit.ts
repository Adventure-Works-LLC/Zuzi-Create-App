/**
 * In-memory IP rate limit for /api/login.
 *
 * SINGLE-INSTANCE ONLY — see AGENTS.md §1. The Map lives in this process; horizontal
 * scaling would silently bypass it. Plan §Hosting pins Railway Hobby (single instance),
 * so this assumption holds for v1.
 *
 * Policy: 5 attempts per 5 minutes per IP, fixed window. Window resets at the first
 * attempt after the previous window expired. Caller increments AFTER the attempt is
 * KNOWN to have failed (so a successful login doesn't count toward the limit).
 *
 * The window resets on process restart (deploy, crash). For a one-user app where the
 * adversary is "someone who guessed the URL", that's an acceptable trade.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Bucket {
  attempts: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until this IP can try again, when ok=false. */
  retryAfterSec?: number;
  /** Attempts remaining in the current window, when ok=true. */
  remaining?: number;
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Take the first (client) entry; chained proxies append.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Check whether this request's IP is within its budget. Does NOT increment — call
 * `recordFailedAttempt` after a verified failure.
 */
export function checkLoginRateLimit(req: Request): RateLimitResult {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    return { ok: true, remaining: MAX_ATTEMPTS };
  }
  if (bucket.attempts >= MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil(
      (bucket.windowStart + WINDOW_MS - now) / 1000,
    );
    return { ok: false, retryAfterSec };
  }
  return { ok: true, remaining: MAX_ATTEMPTS - bucket.attempts };
}

/**
 * Record a failed login attempt for this IP. Starts a new window if none is active.
 */
export function recordFailedAttempt(req: Request): void {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(ip, { attempts: 1, windowStart: now });
    return;
  }
  bucket.attempts += 1;
}

/**
 * Clear the bucket for this IP (call on successful login, so the user isn't punished
 * for previous typos within the same window).
 */
export function clearAttempts(req: Request): void {
  buckets.delete(clientIp(req));
}

/**
 * Test-only: wipe all buckets. Not exported through index — import directly when
 * writing tests against this module.
 */
export function _resetForTests(): void {
  buckets.clear();
}
