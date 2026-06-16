/** 4-column home-board grid; tiles snap to a discrete preset list. */

import type { TileSize } from "./types";

export const GRID_COLS = 4;
export const ROW_HEIGHT_PX = 100;
export const GRID_GAP_PX = 12;

/** Tallest a tile may grow in the resize menu. */
export const MAX_TILE_ROWS = 5;

// Every width (1..GRID_COLS) × height (1..MAX_TILE_ROWS) combination,
// ordered by width then shortest → tallest, so the resize menu reads
// naturally from compact to dramatic.
export const ALL_SIZES: TileSize[] = Array.from(
  { length: GRID_COLS },
  (_, wi) =>
    Array.from({ length: MAX_TILE_ROWS }, (_, hi) => ({
      w: wi + 1,
      h: hi + 1,
    })),
).flat();

export const DEFAULT_SIZE: TileSize = { w: 2, h: 2 };
