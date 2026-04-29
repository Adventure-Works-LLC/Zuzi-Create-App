/**
 * (app) route group layout — applies the warm-near-black studio theme.
 *
 * Per docs/PALETTE.md: Studio runs in `.dark` mode (warm museum-tonal palette
 * pinned in globals.css). The `(auth)` group does NOT add this class so the
 * login page stays in the bright/warm front-door palette.
 *
 * Cookie-protected at the route level via proxy.ts; route handlers also
 * `getSession()` defensively.
 */

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark bg-background text-foreground min-h-dvh font-sans">
      {children}
    </div>
  );
}
