/**
 * Home tiles — type contract.
 *
 * A `TileDefinition` is declarative: it knows how to render content for
 * a tile of a given `type`. A `TileInstance` is a concrete tile placed
 * on a user's board (knows position, size, optional config).
 */

import type { ReactNode } from "react";

export type TileSizeKey = "S" | "M" | "L" | "XL" | "W";

export interface TileSize {
  w: number;
  h: number;
}

export interface TileRenderProps {
  instance: TileInstance;
  isEditMode: boolean;
}

export interface TileDefinition {
  type: string;
  title: string;
  supportedSizes: TileSizeKey[];
  render: (props: TileRenderProps) => ReactNode;
}

export interface TileInstance {
  id: string;
  type: string;
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
