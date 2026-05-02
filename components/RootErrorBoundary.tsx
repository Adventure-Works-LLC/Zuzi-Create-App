"use client";

/**
 * RootErrorBoundary — last-resort visual fallback when something throws
 * during render, hydration, or in a useEffect that React surfaces back
 * up the tree.
 *
 * Specifically replaces the iPad PWA "This page couldn't load" white-
 * screen-with-Reload-buttons crash loop, which is what Safari shows when
 * an unhandled JS error tears down the React root. Instead the user
 * sees: (a) a human message, (b) the actual error so we can debug from a
 * screenshot/photo, (c) a one-tap "clear everything" button that
 * unregisters the service worker, deletes all caches, clears cookies,
 * and reloads — recovers from a stuck PWA without needing to remove the
 * home-screen icon.
 *
 * React 19's error-boundary API is the same as React 16's:
 * `componentDidCatch` + `getDerivedStateFromError` on a class component.
 * Function components don't have an equivalent; this class is the only
 * class component in the codebase and it's intentional.
 *
 * Mounted at the ROOT layout level so it catches anything in the tree
 * including the (auth) login page and the Studio page. PwaRegister is
 * mounted as a sibling so it stays alive even if `children` throws —
 * the SW still installs and the user gets the kill-switch.
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // Best-effort log; the visible UI below is what the user sees, but if
    // the iPad happens to be tethered to a Mac for Web Inspector, this
    // gives us the stack in the JS console too.
    // eslint-disable-next-line no-console
    console.error("[root-error-boundary] caught", error, info);
  }

  /** Nuke all client-side state and reload. The expected fix when an
   *  error came from stale SW cache, expired session cookie, or a
   *  module-scoped state desync. Steps run defensively (each wrapped
   *  in try) so a single failure doesn't block the others — even if
   *  one step throws, we still attempt the rest before reloading. */
  private handleReset = async (): Promise<void> => {
    // 1. Unregister every service worker for this origin. The new SW on
    //    the next page load will install fresh.
    try {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      }
    } catch {
      /* ignore — best effort */
    }

    // 2. Delete every Cache Storage entry. Wipes any chunk / asset / HTML
    //    that an old SW may have stashed.
    try {
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
      }
    } catch {
      /* ignore */
    }

    // 3. Clear cookies for this origin. The session cookie is httpOnly so
    //    document.cookie can't see/clear it directly — but expiring all
    //    visible cookies covers any non-httpOnly state and the server's
    //    session cookie is short-lived enough that worst case is one
    //    extra login. (For full session purge use POST /api/logout, but
    //    that requires a working app — moot if we're in this UI.)
    try {
      if (typeof document !== "undefined") {
        const cookies = document.cookie.split(";");
        for (const c of cookies) {
          const eq = c.indexOf("=");
          const name = (eq > -1 ? c.slice(0, eq) : c).trim();
          if (name) {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 4. Hard-reload bypassing whatever cache we can. location.reload(true)
    //    is non-standard in modern Safari but harmless; the cache wipe
    //    above is what actually makes the next load fresh.
    try {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch {
      /* ignore */
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error.message || String(error);
    const stack = error.stack ?? "";

    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#FAF7F2",
          color: "#1A1612",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "560px",
            textAlign: "left",
          }}
        >
          <h1
            style={{
              fontSize: "28px",
              lineHeight: 1.2,
              margin: "0 0 12px",
              fontWeight: 500,
            }}
          >
            Something went wrong loading the studio.
          </h1>
          <p
            style={{
              fontSize: "15px",
              lineHeight: 1.5,
              margin: "0 0 24px",
              color: "#7A7368",
            }}
          >
            Tap the button below to clear cached state and reload. If the
            error keeps coming back, share a screenshot of this screen with
            Jeff so he can see the message at the bottom.
          </p>

          <button
            type="button"
            onClick={() => {
              void this.handleReset();
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "48px",
              padding: "0 24px",
              background: "#C9602B",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "8px",
              fontSize: "16px",
              fontWeight: 500,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            Reset and reload
          </button>

          <details
            style={{
              marginTop: "32px",
              fontSize: "13px",
              color: "#7A7368",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                userSelect: "none",
                fontWeight: 500,
              }}
            >
              Error details
            </summary>
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                background: "#FFFFFF",
                border: "1px solid #E8E2D6",
                borderRadius: "6px",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                fontSize: "12px",
                lineHeight: 1.5,
                color: "#1A1612",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              <strong>{message}</strong>
              {stack ? `\n\n${stack}` : ""}
            </div>
          </details>
        </div>
      </div>
    );
  }
}
