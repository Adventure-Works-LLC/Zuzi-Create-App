"use client";

import {
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type Source, useCanvas } from "@/stores/canvas";
import { useImageUrl } from "@/hooks/useImageUrl";

const ACCEPTED_EXTS = /\.(jpe?g|png|webp|heic)$/i;
const ACCEPTED_MIME = /^image\//;

interface UploadResponse {
  sourceId: string;
  inputKey: string;
  w: number;
  h: number;
  aspectRatio: string;
}

async function uploadFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  // POST /api/sources: multipart → sharp normalize → R2 → INSERT into sources.
  // Returns {sourceId, inputKey, w, h, aspectRatio} per Prompt 3 schema.
  const resp = await fetch("/api/sources", { method: "POST", body: form });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    const msg = data.detail ?? data.error ?? `upload failed (${resp.status})`;
    throw new Error(msg);
  }
  return (await resp.json()) as UploadResponse;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function SourcePreview({
  source,
  onReplace,
}: {
  source: Source;
  onReplace: () => void;
}) {
  const { url, loading, error } = useImageUrl(source.inputKey);
  return (
    <div className="flex flex-col gap-5 w-full max-w-[420px]">
      {/* Hairline-framed image. The frame + soft inset + drop shadow give a
          gallery-mat feel rather than "img in a card." */}
      <div className="relative">
        <div
          className="
            aspect-square rounded-lg overflow-hidden
            bg-card hairline-frame
            flex items-center justify-center
          "
        >
          {url ? (
            <img
              src={url}
              alt="Source painting"
              className="w-full h-full object-cover"
            />
          ) : loading ? (
            <span className="caption-display text-sm text-text-mute">
              loading…
            </span>
          ) : error ? (
            <span className="text-destructive text-sm text-center px-4">
              {error}
            </span>
          ) : null}
        </div>
      </div>

      {/* Caption — Fraunces italic small-caps style for the meta line. */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="leading-snug">
          <p className="caption-display text-base text-foreground/90">
            Source <span className="text-text-mute">— {formatTime(source.uploadedAt)}</span>
          </p>
          <p className="text-xs text-text-mute mt-0.5 tracking-wide">
            {source.w}×{source.h}
            <span className="mx-2 text-text-mute/50">·</span>
            {source.aspectRatio}
          </p>
        </div>
        <button
          type="button"
          onClick={onReplace}
          className="
            text-xs uppercase tracking-[0.18em] text-text-mute
            hover:text-foreground transition-colors
            no-callout
          "
        >
          Replace
        </button>
      </div>
    </div>
  );
}

export function ImageUploader() {
  const source = useCanvas((s) => s.source);
  const setSource = useCanvas((s) => s.setSource);
  const clearSource = useCanvas((s) => s.clearSource);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      const looksLikeImage =
        ACCEPTED_MIME.test(file.type) || ACCEPTED_EXTS.test(file.name);
      if (!looksLikeImage) {
        setError(`Not an image: ${file.name || file.type || "(unknown)"}`);
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const resp = await uploadFile(file);
        const next: Source = { ...resp, uploadedAt: Date.now() };
        setSource(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [setSource],
  );

  // Document-level paste listener — image from clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void handleFile(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handleFile]);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(true);
  }
  function onDragLeave() {
    setDragOver(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  if (source) {
    return <SourcePreview source={source} onReplace={clearSource} />;
  }

  return (
    <div className="w-full max-w-[420px] flex flex-col gap-5">
      {/* Empty-state hero panel. Generous padding, soft warm bloom behind
          the wordmark. NOT a SaaS uploader card. */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`
          relative overflow-hidden
          aspect-square rounded-lg
          flex flex-col items-center justify-center gap-7 p-8
          bg-card hairline-frame
          transition-all duration-200
          ${dragOver ? "ring-2 ring-accent/60" : ""}
        `}
      >
        <div className="absolute inset-0 bloom-warm" aria-hidden />

        <div className="relative flex flex-col items-center gap-2 text-center">
          <h2 className="font-display text-5xl text-foreground">Begin</h2>
          <p className="caption-display text-sm text-text-mute max-w-[260px] leading-relaxed">
            Drop a sketch, paste from clipboard,
            <br />
            or pick something from your library.
          </p>
        </div>

        {uploading ? (
          <p className="caption-display text-sm text-text-mute relative">
            uploading…
          </p>
        ) : error ? (
          <div className="relative flex flex-col items-center gap-3 max-w-[280px]">
            <p className="text-destructive text-sm text-center leading-snug">
              {error}
            </p>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-text-mute text-xs uppercase tracking-[0.18em] hover:text-foreground transition-colors no-callout"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="relative flex gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="
                rounded-md border border-hairline
                px-4 py-2 text-sm text-foreground/90
                hover:bg-secondary hover:text-foreground
                transition-colors no-callout
              "
            >
              Take photo
            </button>
            <button
              type="button"
              onClick={() => libraryInputRef.current?.click()}
              className="
                rounded-md border border-hairline
                px-4 py-2 text-sm text-foreground/90
                hover:bg-secondary hover:text-foreground
                transition-colors no-callout
              "
            >
              Choose
            </button>
          </div>
        )}

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        <input
          ref={libraryInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
