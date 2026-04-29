"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function safeNextPath(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const form = e.currentTarget;
    const passwordEl = form.elements.namedItem("password") as HTMLInputElement | null;
    const password = passwordEl?.value ?? "";

    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (resp.status === 204) {
        router.push(safeNextPath());
        router.refresh();
        return;
      }
      if (resp.status === 401) {
        setError("That doesn’t look right.");
      } else if (resp.status === 429) {
        const data = (await resp.json().catch(() => ({}))) as { retryAfterSec?: number };
        const sec = data.retryAfterSec ?? 300;
        const min = Math.max(1, Math.ceil(sec / 60));
        setError(`Too many attempts — try again in ${min} minute${min === 1 ? "" : "s"}.`);
      } else if (resp.status === 500) {
        const data = (await resp.json().catch(() => ({}))) as { detail?: string };
        setError(`Server error${data.detail ? `: ${data.detail}` : "."}`);
      } else {
        setError(`Unexpected response (${resp.status}).`);
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden">
      {/* Atmospheric bloom — soft warm radial gradient. The login is the
          "front door": bright, warm, inviting. Deliberate contrast to the
          warm-near-black studio behind it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 28% 32%, rgba(201, 96, 43, 0.18) 0%, transparent 58%), radial-gradient(ellipse at 78% 72%, rgba(232, 196, 156, 0.22) 0%, transparent 60%)",
        }}
      />

      <div className="relative z-10 w-full max-w-[400px] px-8">
        <div className="text-center mb-12">
          <h1 className="font-display text-[44px] leading-none text-foreground tracking-[-0.025em]">
            Zuzi Studio
          </h1>
          <p className="caption-display text-sm text-muted-foreground mt-3">
            A creative ideation tool.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="
            rounded-xl bg-card p-8
            shadow-[0_30px_80px_-32px_rgba(58,30,12,0.20)]
            border border-hairline
            space-y-5
          "
        >
          <div>
            <label
              htmlFor="password"
              className="block text-[10px] uppercase tracking-[0.22em] text-text-mute mb-2.5"
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
              disabled={pending}
              className="h-11 text-base"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="caption-display text-sm text-destructive leading-snug"
            >
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="
              w-full h-11
              font-display tracking-[-0.01em] text-base
            "
            disabled={pending}
          >
            {pending ? "Entering…" : "Enter"}
          </Button>
        </form>
      </div>
    </div>
  );
}
