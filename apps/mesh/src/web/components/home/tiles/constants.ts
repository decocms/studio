/**
 * Grid constants. 3-column snap grid; tiles pick from five preset sizes
 * so the layout stays tidy.
 */

import type { TileSize, TileSizeKey } from "./types";

export const GRID_COLS = 3;
export const ROW_HEIGHT_PX = 240;
export const GRID_GAP_PX = 12;

export const SIZE_PRESETS: Record<TileSizeKey, TileSize> = {
  S: { w: 1, h: 1 },
  M: { w: 1, h: 2 },
  L: { w: 2, h: 1 },
  XL: { w: 2, h: 2 },
  W: { w: 3, h: 1 },
};

export const SIZE_LABELS: Record<TileSizeKey, string> = {
  S: "Small",
  M: "Tall",
  L: "Wide",
  XL: "Large",
  W: "Full width",
};

export const ALL_SIZES: TileSizeKey[] = ["S", "M", "L", "XL", "W"];
