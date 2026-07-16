/** 6-column home-board grid; tiles snap to a discrete preset list. Six columns
 *  so the default metric board reads as three cards across (w:2 each) with the
 *  wider tiles below at half width (w:3). */

import type { TileSize } from "./types";

export const GRID_COLS = 6;
export const ROW_HEIGHT_PX = 100;
export const GRID_GAP_PX = 12;

/** Tallest a tile may grow in the resize menu. */
export const MAX_TILE_ROWS = 5;

export const DEFAULT_SIZE: TileSize = { w: 3, h: 2 };
