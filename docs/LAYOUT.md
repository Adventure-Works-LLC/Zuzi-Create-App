# Layout — pinned

CSS-only responsive behavior. No JavaScript layout logic. Same React component
tree on portrait + landscape; reflow happens via Tailwind's `portrait:` /
`landscape:` variants (which compile to `@media (orientation: ...)` queries).

Don't lock orientation. Don't show a rotation splash. Both work.

## Targets

iPad is the primary device.

| Device                 | Portrait (visible)   | Landscape (visible)   |
|------------------------|---------------------|----------------------|
| iPad Pro 12.9"         | 1024×1366           | 1366×1024            |
| iPad Pro 11" / Air     | 834×1194 (1112)     | 1194×834 (1112)      |
| iPad mini              | 744×1133            | 1133×744             |

Verified via Claude_Preview viewports. Both orientations render the same
React tree; only the layout primitives reflow.

## Studio (`app/(app)/page.tsx`)

```
LANDSCAPE                         PORTRAIT
┌──────────┬─────────────────┐   ┌─────────────────────┐
│          │ Zuzi Studio  ⋯  │   │ Zuzi Studio       ⋯ │
│  source  ├─────────────────┤   ├─────────────────────┤
│  rail    │                 │   │                     │
│  (440px) │   3×3 grid      │   │   source rail       │
│          │   max 820px     │   │   (max-h 58svh)     │
│  Begin   │                 │   │                     │
│          │                 │   ├─────────────────────┤
│          │                 │   │                     │
│          │                 │   │   3×3 grid          │
│          │                 │   │   (full-width)      │
│          │                 │   │                     │
└──────────┴─────────────────┘   └─────────────────────┘
```

### How it's coded

```tsx
<main className="flex flex-col landscape:md:flex-row">
  <header className="landscape:md:hidden …" />        {/* portrait-only top bar */}
  <aside className="
    landscape:md:w-[440px] landscape:md:shrink-0
    landscape:md:border-r portrait:border-b
    portrait:max-h-[58svh] portrait:overflow-y-auto
  ">…</aside>
  <section className="flex-1 …">
    <div className="hidden landscape:md:flex …" />      {/* landscape header */}
    <div className="grid grid-cols-3 …" />              {/* 3×3 grid */}
  </section>
</main>
```

The `landscape:md:` chain is intentional: `md` (≥768px) AND `landscape` orientation
both must hold for the side-by-side layout. Narrow landscape windows (e.g. iPhone
landscape, ≤768px wide) fall back to the portrait stack — that's correct,
side-by-side at 600px wide would crush the grid.

The portrait header lives at the top of `<main>` and is hidden in landscape; the
landscape header lives inside `<section>` (above the grid) and is hidden in
portrait. Same content, different placement.

## Login (`app/(auth)/login/page.tsx`)

Single centered card on a soft warm radial gradient. No orientation-specific
behavior — the card centers in any viewport.

## Theme application

`app/(app)/layout.tsx` wraps Studio routes in `<div className="dark …">` so
the warm-near-black palette pinned in `globals.css` applies. The `(auth)` route
group does NOT add this class so login stays on the bright/warm front-door
palette. See `docs/PALETTE.md`.

## What lives where (current scope)

| Slot in landscape rail OR portrait top section | Component |
|---|---|
| Source preview (when uploaded) | `<SourcePreview>` inside `ImageUploader` |
| Empty-state hero ("Begin") | inside `ImageUploader` |

In Prompt 4 the source rail also gets the `<SourceStrip>` (horizontal scrollable
thumbnails of the multi-source set). The 3×3 grid section gets `<ResultGrid>`,
`<GenerateBar>` (Generate / Refresh + Flash|Pro + 1K|4K toggles + cost),
`<Lightbox>`, `<CompareLightbox>`, `<HistoryDrawer>`. The CSS layout above
already accommodates them — no further breakpoint changes needed.

## What we are NOT doing

- Hiding the layout in portrait. Both orientations are first-class.
- Rotation splash. iOS standalone respects orientation as Zuzi sets it.
- Two completely different React trees per orientation. One tree, CSS reflow.
- JS-driven layout switches via `window.matchMedia` or resize listeners. CSS only.
- Locking width below 768px in landscape into the side-by-side rail. The
  portrait stack is the right fallback for narrow landscape.

## When to update this file

If a new top-level layout decision (sticky bottom prompt bar, drawer side,
new breakpoint) lands, update this file FIRST, then change the code.
