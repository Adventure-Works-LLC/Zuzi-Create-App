export default function Studio() {
  return (
    <main className="flex min-h-svh">
      {/* Left rail — input image lives here */}
      <aside className="w-[440px] shrink-0 border-r border-hairline p-6">
        <div className="aspect-square w-full max-w-[400px] rounded-lg border border-dashed border-hairline bg-card flex items-center justify-center">
          <div className="text-center">
            <p className="font-display text-3xl text-foreground/70">Begin</p>
            <p className="mt-2 text-sm text-text-mute">
              Drop a sketch or photograph
            </p>
          </div>
        </div>
      </aside>

      {/* Main canvas — 3x3 grid + prompt */}
      <section className="flex flex-1 flex-col items-center px-8 py-10">
        {/* 3x3 grid placeholder */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-[700px]">
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-lg bg-card ring-1 ring-hairline"
            />
          ))}
        </div>

        {/* Prompt + chips */}
        <div className="mt-10 w-full max-w-[700px]">
          <div className="rounded-lg border border-hairline bg-card px-4 py-3 text-text-mute">
            Ask anything…
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            {["Color", "Composition", "Lighting", "Background", "Finish", "Mood"].map(
              (label) => (
                <button
                  key={label}
                  type="button"
                  className="rounded border border-hairline px-3 py-1.5 text-foreground/80 hover:bg-secondary no-callout"
                >
                  {label}
                </button>
              )
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
