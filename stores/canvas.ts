/**
 * Canvas store — tracks the current source painting that Generate / Refresh will
 * fire against. Lightbox + iteration state come in Prompts 3 and 4.
 */

import { create } from "zustand";

export interface Source {
  inputKey: string;
  w: number;
  h: number;
  aspectRatio: string;
  publicUrl: string;
  uploadedAt: number;
}

interface CanvasState {
  source: Source | null;
  setSource: (source: Source) => void;
  clearSource: () => void;
}

export const useCanvas = create<CanvasState>((set) => ({
  source: null,
  setSource: (source) => set({ source }),
  clearSource: () => set({ source: null }),
}));
