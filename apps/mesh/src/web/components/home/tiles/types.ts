/**
 * Home tiles — type contract.
 *
 * A `TileInstance` is a concrete tile placed on a user's board (position,
 * size, plus per-preset `config` payload).
 */

export type TileSizeKey = "S" | "M" | "L" | "XL" | "W";

export interface TileSize {
  w: number;
  h: number;
}

export interface TileRenderProps {
  instance: TileInstance;
  isEditMode: boolean;
}

export interface TileInstance {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

export interface HomeBoard {
  version: 3;
  tiles: TileInstance[];
}
