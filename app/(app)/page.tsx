import { ImageUploader } from "@/components/input/ImageUploader";

/**
 * Studio — the working canvas.
 *
 * Responsive layout via CSS-only orientation media queries (no JS):
 *   landscape ≥768px wide:  source rail (left) + canvas (right), 440 + flex
 *   portrait or narrow:     source over canvas, vertical stack, scrolls
 *
 * Layout pinned in docs/LAYOUT.md.
 */
export default function Studio() {
  return (
    <main className="flex flex-col landscape:md:flex-row min-h-dvh">
      {/* Top bar (cross-orientation) — slim wordmark + drawer affordance. */}
      <header
        className="flex items-center justify-between gap-4
                   px-6 py-4 landscape:md:hidden
                   border-b border-hairline"
      >
        <span className="font-display text-2xl tracking-tight text-foreground">
          Zuzi Studio
        </span>
        <span className="caption-display text-sm text-text-mute">
          Studio
        </span>
      </header>

      {/* Source rail
          landscape: fixed-width left column, full height
          portrait:  full-width row at the top, capped height */}
      <aside
        className="
          flex items-center justify-center
          px-6 py-8
          landscape:md:w-[440px] landscape:md:shrink-0
          landscape:md:border-r border-hairline
          portrait:border-b
          portrait:max-h-[58svh] portrait:overflow-y-auto
        "
      >
        <ImageUploader />
      </aside>

      {/* Main canvas — placeholder grid + caption.
          Real ResultGrid + GenerateBar arrive in Prompt 4. */}
      <section
        className="
          flex flex-1 flex-col items-center justify-start
          px-6 py-8 landscape:md:px-12 landscape:md:py-12
          gap-10
        "
      >
        {/* Landscape-only header above the grid (the portrait header is
            already at the top of the main element). */}
        <div className="hidden landscape:md:flex w-full max-w-[820px] items-baseline justify-between">
          <span className="font-display text-3xl tracking-tight text-foreground">
            Zuzi Studio
          </span>
          <span className="caption-display text-sm text-text-mute">
            Studio
          </span>
        </div>

        {/* 3×3 placeholder grid. Tiles are square; gap is hairline-feeling. */}
        <div
          className="
            grid grid-cols-3 gap-3
            w-full max-w-[820px]
          "
          aria-label="Generated tiles will appear here"
        >
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={i}
              className="
                aspect-square rounded-lg bg-card ring-1 ring-hairline/70
                relative overflow-hidden
              "
            >
              <div className="absolute inset-0 bloom-warm opacity-50" aria-hidden />
            </div>
          ))}
        </div>

        <p className="caption-display text-sm text-text-mute mt-2 text-center">
          Your interpretations will appear here.
        </p>
      </section>
    </main>
  );
}
