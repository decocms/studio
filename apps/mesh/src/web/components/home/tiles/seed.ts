/**
 * Board factories. The home is a single page: chat + agents render on top
 * unconditionally, the board below renders only when there are tiles. So
 * an empty board is the natural new-user state — no seeding required.
 *
 * `createStarterBoard` is offered explicitly via the "Use starter layout"
 * affordance in edit mode for users who want a head start. It excludes
 * tiles already present at the top of the page (welcome, quick-chat,
 * recent-agents) and focuses on real dashboard content.
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

export function createEmptyBoard(): HomeBoard {
  return { version: 3, tiles: [] };
}

export function createStarterBoard(): HomeBoard {
  // 3-col bento. A featured pair on top, then compact tiles below.
  //   row 0–1: Recent tasks (1×2)  | Reliability Agent (2×2)
  //   row 2:   Connections (2×1)   | Stats (1×1)
  //   row 3:   GitHub (1×1)        | Linear (1×1)        | Today (1×1)
  return {
    version: 3,
    tiles: [
      tile("studio.recent-tasks", { x: 0, y: 0 }, "M"),
      tile("agent.reliability", { x: 1, y: 0 }, "XL"),
      tile("studio.connections-overview", { x: 0, y: 2 }, "L"),
      tile("studio.stats", { x: 2, y: 2 }, "S"),
      tile("mock.github.activity", { x: 0, y: 3 }, "S"),
      tile("mock.linear.issues", { x: 1, y: 3 }, "S"),
      tile("mock.calendar.upcoming", { x: 2, y: 3 }, "S"),
    ],
  };
}
