/**
 * Default board seeding. The first time a user opts in we want them to
 * land on something that *looks* like a real dashboard so they can see
 * what the system is for, not on an empty canvas with an "Add" button.
 */

import { SIZE_PRESETS } from "./constants";
import type { HomeBoard, TileInstance } from "./types";

function newId(): string {
  return `tile_${Math.random().toString(36).slice(2, 10)}`;
}

function tile(
  type: string,
  pos: { x: number; y: number },
  sizeKey: keyof typeof SIZE_PRESETS,
  config?: Record<string, unknown>,
): TileInstance {
  const size = SIZE_PRESETS[sizeKey];
  return {
    id: newId(),
    type,
    x: pos.x,
    y: pos.y,
    w: size.w,
    h: size.h,
    config,
  };
}

export function createSimpleBoard(): HomeBoard {
  return { version: 1, layout: "simple", tiles: [] };
}

export function createStarterTilesBoard(): HomeBoard {
  // Bento layout, all rows fill 12 cols cleanly:
  //   row 0–1:  Welcome                      (W: 12)
  //   row 2–4:  Recent agents | tasks | conn (M+M+M = 4+4+4)
  //   row 5–7:  Quick chat   | Shortcuts     (L+L = 6+6)
  //   row 8–10: Stats | GitHub | Linear      (M+M+M = 4+4+4)
  return {
    version: 1,
    layout: "tiles",
    tiles: [
      tile("studio.welcome", { x: 0, y: 0 }, "W"),
      tile("studio.recent-agents", { x: 0, y: 2 }, "M"),
      tile("studio.recent-tasks", { x: 4, y: 2 }, "M"),
      tile("studio.connections-overview", { x: 8, y: 2 }, "M"),
      tile("studio.quick-chat", { x: 0, y: 5 }, "L"),
      tile("studio.shortcuts", { x: 6, y: 5 }, "L"),
      tile("studio.stats", { x: 0, y: 8 }, "M"),
      tile("mock.github.activity", { x: 4, y: 8 }, "M"),
      tile("mock.linear.issues", { x: 8, y: 8 }, "M"),
    ],
  };
}

export function createEmptyTilesBoard(): HomeBoard {
  return { version: 1, layout: "tiles", tiles: [] };
}
