import { ImageUploader } from "@/components/input/ImageUploader";

export default function Studio() {
  return (
    <main className="flex min-h-svh">
      <aside className="w-[440px] shrink-0 border-r border-hairline p-6 flex items-center justify-center">
        <ImageUploader />
      </aside>

      <section className="flex flex-1 flex-col items-center px-8 py-10">
        <div className="grid grid-cols-3 gap-3 w-full max-w-[700px]">
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-lg bg-card ring-1 ring-hairline"
            />
          ))}
        </div>
        <p className="mt-10 text-text-mute text-xs">
          Generate / Refresh + grid streaming — Prompt 3
        </p>
      </section>
    </main>
  );
}
