"use client";

/**
 * useShare — feature-detect the Web Share API for file shares.
 *
 * On iOS Safari, `navigator.share({ files: [File] })` opens the native share
 * sheet which natively includes "Save Image" alongside AirDrop, Messages, and
 * the user's other configured targets. AGENTS.md §4 pins this as the
 * save-to-camera-roll path.
 *
 * This hook returns just `{ canShare }` — a feature detect for whether the
 * Web Share API exists at all. The caller is responsible for:
 *
 *   1. Pre-fetching the image bytes into a Blob BEFORE the user click. iOS
 *      requires `navigator.share` to run synchronously inside the user-
 *      gesture event handler — any `await` between the click and the share
 *      call breaks the gesture chain and iOS rejects the share. Pre-fetching
 *      removes the await.
 *   2. Constructing the File synchronously from the pre-fetched Blob inside
 *      the click handler.
 *   3. Calling `navigator.canShare({ files: [file] })` with the actual
 *      constructed File (the API-existence check we do here doesn't tell us
 *      whether THIS file is shareable — file types, sizes, and PWA contexts
 *      can all reject specific files).
 *   4. Calling `navigator.share(...)` synchronously after canShare passes.
 *      Awaiting the returned Promise for success/failure is fine.
 *
 * The caller also needs to handle:
 *   - The user-dismissed-the-share-sheet case (rejects with `AbortError`,
 *     which is NOT an error — silently ignore).
 *   - Falling back to a download link when `canShare({files})` returns false
 *     for the specific file (some PWA contexts).
 *
 * The `Lightbox` component in `components/krea/Lightbox.tsx` is the canonical
 * implementation of this dance. If you find yourself replicating it
 * elsewhere, lift the logic into a shared helper rather than re-inventing it.
 *
 * History: an earlier version of this hook exposed a `shareImage(url)`
 * helper that fetched-then-shared inside the same async function. That
 * pattern silently failed on iOS because the `await fetch(...)` between
 * click and `navigator.share()` killed the user-gesture context. It also
 * swallowed errors to a fall-through `download` path with no surfacing.
 * Both bugs are described in `git log` around the Lightbox Share fix.
 */

import { useEffect, useState } from "react";

export interface UseShareResult {
  /** True iff `navigator.share` and `navigator.canShare` both exist as
   *  functions in the current runtime. This is the API-existence check
   *  only — the per-file capability check (`navigator.canShare({files: [
   *  file]})`) must still be performed inside the click handler with the
   *  actual File. */
  canShare: boolean;
}

export function useShare(): UseShareResult {
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setCanShare(
      typeof navigator.share === "function" &&
        typeof navigator.canShare === "function",
    );
  }, []);

  return { canShare };
}
