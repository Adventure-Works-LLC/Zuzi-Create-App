import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden">
      {/* Soft warm radial gradient for atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 30% 30%, rgba(201, 96, 43, 0.18) 0%, transparent 55%), radial-gradient(ellipse at 75% 70%, rgba(232, 196, 156, 0.25) 0%, transparent 60%)",
        }}
      />

      <div className="relative z-10 w-full max-w-[380px] px-8">
        <h1 className="font-display text-4xl text-center text-foreground tracking-tight">
          Zuzi Studio
        </h1>

        <form
          method="post"
          action="/api/login"
          className="mt-10 rounded-2xl bg-card p-8 shadow-sm border border-hairline space-y-4"
        >
          <div>
            <label
              htmlFor="password"
              className="block text-xs uppercase tracking-wider text-text-mute mb-2"
            >
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full h-11 text-base">
            Enter
          </Button>
        </form>
      </div>
    </div>
  );
}
