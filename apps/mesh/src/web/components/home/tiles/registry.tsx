/**
 * Tile catalog — three preset tiles, one per task in the side panel.
 * A tile lands on the user's board when they start its matching task;
 * dnd / resize / remove come from the shared TileBoard chrome.
 */

import { Activity, Globe02, Stars01 } from "@untitledui/icons";
import {
  BrandContextTile,
  ErrorMonitoringTile,
  LandingPageTile,
  UnknownTile,
} from "./renderers";
import type { TileDefinition, TileRenderProps } from "./types";

export type PresetTileType =
  | "studio.brand-context"
  | "studio.landing-page"
  | "studio.error-monitoring";

export const PRESET_DEFAULT_SIZE = "L" as const;

const TILE_CATALOG: TileDefinition[] = [
  {
    type: "studio.brand-context",
    source: "system",
    title: "Brand context",
    description: "Colors, fonts, and tone pulled from your site.",
    icon: <Stars01 size={14} />,
    category: "essentials",
    supportedSizes: ["S", "M", "L", "XL", "W"],
    defaultSize: PRESET_DEFAULT_SIZE,
    render: BrandContextTile,
  },
  {
    type: "studio.landing-page",
    source: "system",
    title: "Landing page",
    description: "Page draft generated for your brand.",
    icon: <Globe02 size={14} />,
    category: "essentials",
    supportedSizes: ["S", "M", "L", "XL", "W"],
    defaultSize: PRESET_DEFAULT_SIZE,
    render: LandingPageTile,
  },
  {
    type: "studio.error-monitoring",
    source: "system",
    title: "System health",
    description: "Live errors and uptime.",
    icon: <Activity size={14} />,
    category: "essentials",
    supportedSizes: ["S", "M", "L", "XL", "W"],
    defaultSize: PRESET_DEFAULT_SIZE,
    render: ErrorMonitoringTile,
  },
];

const BY_TYPE = new Map(TILE_CATALOG.map((t) => [t.type, t]));

export function getTileDefinition(type: string): TileDefinition | undefined {
  return BY_TYPE.get(type);
}

export function renderTileContent(type: string, props: TileRenderProps) {
  const def = getTileDefinition(type);
  const Renderer = def?.render ?? UnknownTile;
  return <Renderer {...props} />;
}
