/**
 * Grid constants. The board is a 12-column snap grid; tiles only ever
 * pick from four sizes so the layout stays tidy.
 */

import type { TileSize, TileSizeKey } from "./types";

export const GRID_COLS = 12;

/**
 * Vertical cell size. 96px gives tiles real breathing room — an M (4×3)
 * is 288px tall, plenty for headers, content, and hover affordances
 * without feeling cramped.
 */
export const ROW_HEIGHT_PX = 96;

export const GRID_GAP_PX = 12;

/**
 * Tile sizes, all expressed in 12-col cells. The 4 sizes line up cleanly:
 * - S (3×2) — quarter-row mini card
 * - M (4×3) — third-row standard card (the bento workhorse)
 * - L (6×3) — half-row landscape (chats, charts, dual-pane lists)
 * - W (12×2) — full-bleed hero strip (welcome, banners)
 */
export const SIZE_PRESETS: Record<TileSizeKey, TileSize> = {
  S: { w: 3, h: 2 },
  M: { w: 4, h: 3 },
  L: { w: 6, h: 3 },
  W: { w: 12, h: 2 },
};

export const SIZE_LABELS: Record<TileSizeKey, string> = {
  S: "Small",
  M: "Medium",
  L: "Large",
  W: "Wide",
};

export const ALL_SIZES: TileSizeKey[] = ["S", "M", "L", "W"];

export const MOBILE_BREAKPOINT_COLS = 1;
