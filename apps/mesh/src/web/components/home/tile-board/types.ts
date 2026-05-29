/**
 * Tile-board types. A `TileInstance` is a stable id + position + size in
 * the 3-column grid; the rendered content lives outside this module so
 * the board stays generic.
 */

export type TileSizeKey =
  | "S"
  | "M"
  | "L"
  | "XL"
  | "W"
  | "T"
  | "LT"
  | "WT"
  | "XLT"
  | "XXLT";

export interface TileSize {
  w: number;
  h: number;
}

export interface TileInstance {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Minimum width in grid columns. Defaults to 1. Used to filter resize
   *  presets so the user can't shrink a tile below what its content needs. */
  minW?: number;
  /** Minimum height in grid rows. Defaults to 1. */
  minH?: number;
}

export interface BoardLayout {
  version: 1;
  /** Tile-id → position+size. Tiles missing from the layout get auto-placed. */
  tiles: Record<string, { x: number; y: number; w: number; h: number }>;
  /** Tile ids the user has explicitly hidden from the board. */
  hidden: string[];
}
