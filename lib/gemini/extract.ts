/**
 * Extract image bytes from a Gemini generateContent response, with magic-byte sniffing.
 *
 * Known Google bug: `inlineData.mimeType` sometimes claims "image/png" while the actual
 * bytes are JPEG (\xFF\xD8\xFF...). We trust the bytes, not the declared MIME. This module
 * is the single shared parser for both `scripts/smoke.ts` and the future `runIteration`
 * worker, so the bug only ever needs to be fixed in one place.
 *
 * Errors are classified so they surface meaningfully through the deep error-capture
 * pipeline in `lib/gemini/errors.ts`, not as silent corruptions.
 */

export type DetectedMime = "image/png" | "image/jpeg";

export interface ExtractedImage {
  bytes: Buffer;
  detectedMime: DetectedMime;
  declaredMime: string | null;
}

export type ExtractClassification =
  | "no_image"
  | "safety_block"
  | "unexpected_magic_bytes"
  | "empty_response";

export class GeminiExtractError extends Error {
  readonly classification: ExtractClassification;
  readonly detail?: string;
  constructor(
    message: string,
    classification: ExtractClassification,
    detail?: string,
  ) {
    super(message);
    this.name = "GeminiExtractError";
    this.classification = classification;
    this.detail = detail;
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC_3 = Buffer.from([0xff, 0xd8, 0xff]);

function sniffMime(bytes: Buffer): DetectedMime {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC_3)) {
    return "image/jpeg";
  }
  const head = bytes.subarray(0, Math.min(16, bytes.length)).toString("hex");
  throw new GeminiExtractError(
    `Unexpected magic bytes (head=${head})`,
    "unexpected_magic_bytes",
    head,
  );
}

interface RawPart {
  inlineData?: { data?: string; mimeType?: string };
  text?: string;
}

interface RawResp {
  candidates?: { content?: { parts?: RawPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export function extractImageBytes(resp: unknown): ExtractedImage {
  const r = resp as RawResp;

  if (!r || typeof r !== "object") {
    throw new GeminiExtractError("Empty or non-object response", "empty_response");
  }

  const blockReason = r?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiExtractError(
      `Blocked by safety filter: ${blockReason}`,
      "safety_block",
      blockReason,
    );
  }

  const candidate = r?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason === "SAFETY") {
    throw new GeminiExtractError(
      "Blocked by safety filter (finishReason: SAFETY)",
      "safety_block",
      finishReason,
    );
  }

  const parts = candidate?.content?.parts ?? [];
  for (const part of parts) {
    const data = part?.inlineData?.data;
    const mime = part?.inlineData?.mimeType;
    if (typeof data === "string" && data.length > 0) {
      const bytes = Buffer.from(data, "base64");
      // Trust the bytes, not the declared mime.
      const detectedMime = sniffMime(bytes); // throws GeminiExtractError on unknown magic
      return {
        bytes,
        detectedMime,
        declaredMime: typeof mime === "string" ? mime : null,
      };
    }
  }

  const textParts = parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  throw new GeminiExtractError(
    `No image in response (finishReason=${finishReason ?? "?"}). Text parts: ${
      textParts.join(" | ").slice(0, 300) || "(none)"
    }`,
    "no_image",
  );
}
