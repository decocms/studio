/**
 * Tile catalog — three preset tiles, one per task in the side panel.
 * A tile lands on the user's board when the user starts its matching
 * task; dnd / resize / remove come from the shared TileBoard chrome.
 */

import {
  BrandContextTile,
  ErrorMonitoringTile,
  LandingPageTile,
} from "./renderers";
import type { TileDefinition } from "./types";

export type PresetTileType =
  | "studio.brand-context"
  | "studio.landing-page"
  | "studio.error-monitoring";

export const PRESET_DEFAULT_SIZE = "L" as const;

const SUPPORTED_SIZES = ["S", "M", "L", "XL", "W"] as const;

const TILE_CATALOG: TileDefinition[] = [
  {
    type: "studio.brand-context",
    title: "Brand context",
    supportedSizes: [...SUPPORTED_SIZES],
    render: BrandContextTile,
  },
  {
    type: "studio.landing-page",
    title: "Landing page",
    supportedSizes: [...SUPPORTED_SIZES],
    render: LandingPageTile,
  },
  {
    type: "studio.error-monitoring",
    title: "System health",
    supportedSizes: [...SUPPORTED_SIZES],
    render: ErrorMonitoringTile,
  },
];

const BY_TYPE = new Map(TILE_CATALOG.map((t) => [t.type, t]));

export function getTileDefinition(type: string): TileDefinition | undefined {
  return BY_TYPE.get(type);
}
