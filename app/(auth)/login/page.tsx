"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function safeNextPath(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  // Only allow same-origin paths starting with "/" and without a scheme/protocol.
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
        setError("Wrong password.");
      } else if (resp.status === 429) {
        const data = (await resp.json().catch(() => ({}))) as { retryAfterSec?: number };
        const sec = data.retryAfterSec ?? 300;
        const min = Math.max(1, Math.ceil(sec / 60));
        setError(`Too many attempts. Try again in ${min} minute${min === 1 ? "" : "s"}.`);
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
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden">
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
          onSubmit={handleSubmit}
          noValidate
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
              disabled={pending}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full h-11 text-base" disabled={pending}>
            {pending ? "Entering…" : "Enter"}
          </Button>
        </form>
      </div>
    </div>
  );
}
