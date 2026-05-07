/**
 * Grid constants. The board is a 12-column snap grid; tiles only ever
 * pick from four sizes so the layout stays tidy.
 */

import type { TileSize, TileSizeKey } from "./types";

export const GRID_COLS = 12;

export const ROW_HEIGHT_PX = 96;

export const GRID_GAP_PX = 12;

export const SIZE_PRESETS: Record<TileSizeKey, TileSize> = {
  S: { w: 3, h: 2 },
  M: { w: 4, h: 3 },
  L: { w: 6, h: 4 },
  W: { w: 12, h: 3 },
};

export const SIZE_LABELS: Record<TileSizeKey, string> = {
  S: "Small",
  M: "Medium",
  L: "Large",
  W: "Wide",
};

export const ALL_SIZES: TileSizeKey[] = ["S", "M", "L", "W"];

export const MOBILE_BREAKPOINT_COLS = 1;
