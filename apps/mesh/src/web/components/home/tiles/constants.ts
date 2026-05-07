/**
 * Grid constants. The board is a 12-column snap grid; tiles only ever
 * pick from four sizes so the layout stays tidy.
 */

import type { TileSize, TileSizeKey } from "./types";

export const GRID_COLS = 3;

/**
 * Vertical cell size. 240px gives a 1×1 a card-like feel (roughly 7:4
 * landscape on a 1280px-wide board) and makes a 1×2 a properly tall
 * list column without dominating the viewport.
 */
export const ROW_HEIGHT_PX = 240;

export const GRID_GAP_PX = 12;

/**
 * Tile sizes, all expressed in 3-col cells. Coarse on purpose — keeping
 * the grid simple and bento-like:
 * - S  (1×1) — small square card
 * - M  (1×2) — single column, double tall (lists)
 * - L  (2×1) — two cols wide, one row tall (landscape)
 * - XL (2×2) — chunky square (hero charts, primary content)
 * - W  (3×1) — full-width strip (banners, welcome)
 */
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
  W: "Banner",
};

export const ALL_SIZES: TileSizeKey[] = ["S", "M", "L", "XL", "W"];

export const MOBILE_BREAKPOINT_COLS = 1;
