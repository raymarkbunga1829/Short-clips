import { hashTopic } from "./script";

export interface Palette {
  id: string;
  /** Three colours fed to ffmpeg's animated gradient source, dark to light. */
  colors: [string, string, string];
  /** Highlight colour for the active caption word, as #RRGGBB. */
  accent: string;
  /** Gradient shape. "radial" is deliberately unused: it washes out the middle
   * of the frame, which is exactly where the captions sit. */
  type: "linear" | "circular" | "spiral";
}

export const PALETTES: Palette[] = [
  { id: "midnight", colors: ["#060B17", "#152238", "#2E4670"], accent: "#7DD3FC", type: "linear" },
  { id: "ember", colors: ["#150707", "#6B240E", "#E1650F"], accent: "#FDE68A", type: "spiral" },
  { id: "mint", colors: ["#04211F", "#0B5D57", "#28B48C"], accent: "#FDE047", type: "circular" },
  { id: "grape", colors: ["#120C33", "#3F1880", "#8B5CF6"], accent: "#FDE047", type: "spiral" },
  { id: "ocean", colors: ["#02121F", "#0A3D5C", "#0C87C4"], accent: "#FDE68A", type: "linear" },
  { id: "rose", colors: ["#210719", "#84123F", "#E45D72"], accent: "#FDE68A", type: "circular" },
];

export function pickPalette(topic: string, requested?: string): Palette {
  if (requested) {
    const match = PALETTES.find((palette) => palette.id === requested.toLowerCase());
    if (match) return match;
  }
  return PALETTES[hashTopic(topic) % PALETTES.length];
}
