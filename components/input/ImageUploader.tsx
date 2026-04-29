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
    hour: "2-digit",
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
    <div className="flex flex-col gap-3 w-full max-w-[400px]">
      <div className="aspect-square rounded-lg bg-card ring-1 ring-hairline overflow-hidden flex items-center justify-center">
        {url ? (
          <img
            src={url}
            alt="Source painting"
            className="w-full h-full object-cover"
          />
        ) : loading ? (
          <span className="text-text-mute text-sm">Loading…</span>
        ) : error ? (
          <span className="text-destructive text-sm text-center px-4">
            {error}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-text-mute leading-tight">
          Source — {formatTime(source.uploadedAt)}
          <br />
          <span className="text-xs">
            {source.w}×{source.h} · {source.aspectRatio}
          </span>
        </span>
        <button
          type="button"
          onClick={onReplace}
          className="text-text-mute hover:text-foreground text-xs underline shrink-0"
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
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`aspect-square w-full max-w-[400px] rounded-lg border border-dashed
        ${dragOver ? "border-accent bg-card/80" : "border-hairline bg-card"}
        flex flex-col items-center justify-center gap-4 p-6 transition-colors`}
    >
      {uploading ? (
        <p className="text-text-mute">Uploading…</p>
      ) : error ? (
        <>
          <p className="text-destructive text-sm text-center max-w-[280px]">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-text-mute text-xs underline"
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <p className="font-display text-3xl text-foreground/70">Begin</p>
          <p className="text-sm text-text-mute text-center">
            Drop a sketch or photo,
            <br />
            paste, or pick one
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="rounded border border-hairline px-3 py-1.5 text-sm hover:bg-secondary no-callout"
            >
              Take photo
            </button>
            <button
              type="button"
              onClick={() => libraryInputRef.current?.click()}
              className="rounded border border-hairline px-3 py-1.5 text-sm hover:bg-secondary no-callout"
            >
              Choose
            </button>
          </div>
        </>
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
  );
}
