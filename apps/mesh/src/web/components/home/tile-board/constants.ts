/** 4-column home-board grid; tiles snap to a discrete preset list. */

import type { TileSize, TileSizeKey } from "./types";

export const GRID_COLS = 4;
export const ROW_HEIGHT_PX = 100;
export const GRID_GAP_PX = 12;

export const SIZE_PRESETS: Record<TileSizeKey, TileSize> = {
  S: { w: 1, h: 1 },
  M: { w: 1, h: 2 },
  T: { w: 1, h: 3 },
  L: { w: 2, h: 1 },
  XL: { w: 2, h: 2 },
  LT: { w: 2, h: 3 },
  XLT: { w: 2, h: 4 },
  XXLT: { w: 2, h: 5 },
  W: { w: 4, h: 1 },
  WT: { w: 4, h: 3 },
};

export const SIZE_LABELS: Record<TileSizeKey, string> = {
  S: "Small",
  M: "Tall",
  T: "Column",
  L: "Wide",
  XL: "Large",
  LT: "Showcase",
  XLT: "Display",
  XXLT: "Tower",
  W: "Full width",
  WT: "Hero",
};

// Ordered shortest → tallest within each width so the resize menu reads
// naturally from compact to dramatic.
export const ALL_SIZES: TileSizeKey[] = [
  "S",
  "M",
  "T",
  "L",
  "XL",
  "LT",
  "XLT",
  "XXLT",
  "W",
  "WT",
];

export const DEFAULT_SIZE: TileSize = SIZE_PRESETS.XL;
