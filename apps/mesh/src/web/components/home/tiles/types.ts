/**
 * Home tiles — type contract.
 *
 * A `TileDefinition` is declarative: it knows how to render content
 * for a tile of a given `type`. A `TileInstance` is a concrete tile
 * placed on a user's board (knows position, size, optional config).
 *
 * Today every definition ships with the app; the `source` discriminator
 * is here so we can later attribute tiles to specific agents or MCP
 * connections in the catalog UI.
 */

import type { ReactNode } from "react";

export type TileSizeKey = "S" | "M" | "L" | "W";

export interface TileSize {
  w: number;
  h: number;
}

export type TileSource = "system" | "agent" | "mcp";

export type TileCategory =
  | "essentials"
  | "activity"
  | "stats"
  | "shortcuts"
  | "data"
  | "workflow";

export interface TileRenderProps {
  instance: TileInstance;
  isEditMode: boolean;
}

export interface TileDefinition {
  type: string;
  source: TileSource;
  sourceId?: string;
  title: string;
  description: string;
  icon: ReactNode;
  category: TileCategory;
  supportedSizes: TileSizeKey[];
  defaultSize: TileSizeKey;
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

export type HomeLayoutMode = "simple" | "tiles";

export interface HomeBoard {
  version: 1;
  layout: HomeLayoutMode;
  tiles: TileInstance[];
}
