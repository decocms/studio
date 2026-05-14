/**
 * Catalog of home tiles. Three preset tiles map 1:1 to the preset task
 * cards in the side panel. A tile only renders once the user has started
 * its corresponding task.
 */

import {
  BrandContextTile,
  ErrorMonitoringTile,
  LandingPageTile,
} from "./renderers";
import type { TileDefinition, TileId } from "./types";

export const TILES: Record<TileId, TileDefinition> = {
  "brand-context": {
    id: "brand-context",
    title: "Extract brand context",
    runningLabel: "Pulling colors, fonts, and tone.",
    readyLabel: "Brand snapshot from your site.",
    badgeClass: "bg-[#FBE862] text-[#1F2937]",
    Render: BrandContextTile,
  },
  "landing-page": {
    id: "landing-page",
    title: "Create landing page",
    runningLabel: "Generating sections from your brand.",
    readyLabel: "Page draft ready.",
    badgeClass: "bg-[#BEE5FA] text-[#1F2937]",
    Render: LandingPageTile,
  },
  "error-monitoring": {
    id: "error-monitoring",
    title: "Set up error monitoring",
    runningLabel: "Connecting your stack.",
    readyLabel: "Errors are streaming in.",
    badgeClass: "bg-[#FAD2A2] text-[#1F2937]",
    Render: ErrorMonitoringTile,
  },
};

export const TILE_IDS: TileId[] = [
  "brand-context",
  "landing-page",
  "error-monitoring",
];
