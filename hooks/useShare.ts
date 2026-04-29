"use client";

/**
 * useShare — wrap navigator.share for the lightbox's "Share" button.
 *
 * On iOS Safari, `navigator.share({ files: [File] })` opens the native share
 * sheet which natively includes "Save Image" alongside AirDrop, Messages, and
 * the user's other configured targets. AGENTS.md §4 pins this as the
 * save-to-camera-roll path.
 *
 * Falls back to a plain link tag with download attribute if Web Share isn't
 * supported. Also exposes `canShare` so the UI can hide the button on
 * unsupported browsers (with the well-known long-press → Save Image fallback
 * still working on any <img> for free).
 */

import { useCallback, useEffect, useState } from "react";

export interface UseShareResult {
  canShare: boolean;
  shareImage: (args: { url: string; filename?: string; title?: string }) => Promise<void>;
}

export function useShare(): UseShareResult {
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setCanShare(
      typeof navigator.share === "function" &&
        // canShare with files is the right capability check on iOS.
        typeof navigator.canShare === "function",
    );
  }, []);

  const shareImage = useCallback(
    async ({ url, filename = "zuzi.jpg", title }: { url: string; filename?: string; title?: string }) => {
      if (typeof navigator === "undefined") return;

      // Try the file-share path first (best UX — native share sheet).
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const blob = await resp.blob();
        const file = new File([blob], filename, {
          type: blob.type || "image/jpeg",
        });
        if (
          typeof navigator.share === "function" &&
          typeof navigator.canShare === "function" &&
          navigator.canShare({ files: [file] })
        ) {
          await navigator.share({ files: [file], title });
          return;
        }
      } catch {
        /* fall through to download */
      }

      // Fallback: trigger a same-tab download. The user can long-press the
      // resulting image in Photos to save manually if even this fails.
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [],
  );

  return { canShare, shareImage };
}
