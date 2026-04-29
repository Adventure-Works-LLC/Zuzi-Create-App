import { GoogleGenAI } from "@google/genai";

if (!process.env.GEMINI_API_KEY) {
  throw new Error(
    "GEMINI_API_KEY is missing. Drop it in .env at the repo root, then run with: node --env-file=.env --import tsx <script>",
  );
}

export const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const PLANNER_MODEL = "gemini-2.5-flash";
export const IMAGE_MODEL_PRO = "gemini-3-pro-image-preview";
export const IMAGE_MODEL_FLASH = "gemini-3.1-flash-image-preview";
