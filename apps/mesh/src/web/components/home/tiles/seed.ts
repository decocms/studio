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
  return { version: 2, tiles: [] };
}

export function createStarterBoard(): HomeBoard {
  // Dashboard-focused starter, all rows fill 12 cols cleanly:
  //   row 0–2: Recent tasks | Connections | Stats     (M+M+M)
  //   row 3–5: GitHub       | Linear      | Calendar  (M+M+M)
  //   row 6–8: Notes (L)    | Shortcuts (L)            (L+L)
  return {
    version: 2,
    tiles: [
      tile("studio.recent-tasks", { x: 0, y: 0 }, "M"),
      tile("studio.connections-overview", { x: 4, y: 0 }, "M"),
      tile("studio.stats", { x: 8, y: 0 }, "M"),
      tile("mock.github.activity", { x: 0, y: 3 }, "M"),
      tile("mock.linear.issues", { x: 4, y: 3 }, "M"),
      tile("mock.calendar.upcoming", { x: 8, y: 3 }, "M"),
      tile("studio.notes", { x: 0, y: 6 }, "L"),
      tile("studio.shortcuts", { x: 6, y: 6 }, "L"),
    ],
  };
}
