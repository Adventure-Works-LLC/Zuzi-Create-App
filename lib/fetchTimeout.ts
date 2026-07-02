/**
 * withTimeout — merge a timeout AbortSignal into a fetch RequestInit.
 *
 * v4.6 hardening: NO fetch in this app had a timeout, so any request that
 * hung without erroring (iPad wifi drop mid-request is the canonical case)
 * left its in-flight flag (`uploading`, `generating`, `fireInFlight`,
 * `batchInFlight`, …) stuck forever — disabling Generate app-wide, locking
 * the ExploreSheet shut, etc., until a full reload. A timed-out request
 * rejects with a DOMException named "TimeoutError", which callers' existing
 * catch paths treat as an ordinary failure: flags reset in `finally`, the
 * message surfaces, the user retries.
 *
 * Policy (per the v4.6 network audit):
 *   - JSON GET/POST/PATCH/DELETE → 30s  (TIMEOUT_JSON_MS)
 *   - multipart uploads + image-bytes prefetch → 120s (TIMEOUT_UPLOAD_MS)
 *   - EventSource / SSE → none (long-lived by design)
 *
 * Signal merging: when the caller already passes a signal (source-switch
 * aborts etc.), we combine via AbortSignal.any so EITHER cancels. On
 * runtimes without AbortSignal.any (pre-17.4 iOS Safari) we keep the
 * caller's signal and drop the timeout — the caller's abort semantics are
 * more load-bearing than the timeout. Runtimes without AbortSignal.timeout
 * at all get the init back unchanged.
 */

export const TIMEOUT_JSON_MS = 30_000;
export const TIMEOUT_UPLOAD_MS = 120_000;

export function withTimeout(
  init: RequestInit | undefined,
  ms: number,
): RequestInit {
  if (
    typeof AbortSignal === "undefined" ||
    typeof AbortSignal.timeout !== "function"
  ) {
    return init ?? {};
  }
  const timeoutSignal = AbortSignal.timeout(ms);
  const existing = init?.signal ?? null;
  const signal = existing
    ? typeof AbortSignal.any === "function"
      ? AbortSignal.any([existing, timeoutSignal])
      : existing
    : timeoutSignal;
  return { ...init, signal };
}
