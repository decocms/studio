/**
 * Tile catalog — one generic "preset" tile. Identity (which preset)
 * lives in `config.presetId`; the renderer looks up the preset's
 * display + state via `usePresetTasks` and delegates the body to a
 * per-preset module keyed by `presetId`.
 */

import { PresetTile } from "./renderers";
import type { TileDefinition } from "./types";

const SUPPORTED_SIZES = ["S", "M", "L", "XL", "W"] as const;

export const PRESET_TILE_TYPE = "preset";

const TILE_CATALOG: TileDefinition[] = [
  {
    type: PRESET_TILE_TYPE,
    title: "Preset",
    supportedSizes: [...SUPPORTED_SIZES],
    render: PresetTile,
  },
];

const BY_TYPE = new Map(TILE_CATALOG.map((t) => [t.type, t]));

export function getTileDefinition(type: string): TileDefinition | undefined {
  return BY_TYPE.get(type);
}
