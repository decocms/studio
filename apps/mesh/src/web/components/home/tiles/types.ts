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

export type TileSizeKey = "S" | "M" | "L" | "XL" | "W";

export interface TileSize {
  w: number;
  h: number;
}

export type TileSource = "system" | "agent" | "mcp";

export type TileCategory =
  | "essentials"
  | "agents"
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
  /**
   * Initial config baked into a TileInstance when it's added from the
   * catalog. Used by tile types that need per-instance metadata
   * (e.g., agent.card carries the agent's templateId, title, icon).
   */
  defaultConfig?: Record<string, unknown>;
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

/**
 * The user's home is a single page: chat + agents on top, then this tile
 * board below. The board is empty by default — tiles appear when the user
 * pins them. There is no "mode" to switch between.
 */
export interface HomeBoard {
  version: 3;
  tiles: TileInstance[];
}
