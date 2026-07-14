/** 4-column home-board grid; tiles snap to a discrete preset list. */

import type { TileSize } from "./types";

export const GRID_COLS = 4;
export const ROW_HEIGHT_PX = 100;
export const GRID_GAP_PX = 12;

/** Tallest a tile may grow in the resize menu. */
export const MAX_TILE_ROWS = 5;

export const DEFAULT_SIZE: TileSize = { w: 2, h: 2 };
