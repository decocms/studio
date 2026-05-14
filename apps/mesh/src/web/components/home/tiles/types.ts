/**
 * Home tiles — type contract.
 *
 * Each tile maps 1:1 to a preset task in the side panel. When the user
 * starts that task, the tile is "activated" and renders below the chat.
 */

import type { ComponentType } from "react";

export type TileId = "brand-context" | "landing-page" | "error-monitoring";

export type TileStatus = "running" | "ready";

export interface TileState {
  id: TileId;
  /** Task/thread that last activated this tile, used to link back to chat. */
  taskId: string;
  status: TileStatus;
  /** ISO timestamp of the most recent activation. */
  updatedAt: string;
}

export interface TileDefinition {
  id: TileId;
  title: string;
  /** Lead sentence rendered as the tile's eyebrow / running copy. */
  runningLabel: string;
  readyLabel: string;
  /** Tailwind class for the colored image badge background. */
  badgeClass: string;
  Render: ComponentType<{ state: TileState }>;
}
