/**
 * Board factories. The home is a single page: chat + agents render on top
 * unconditionally, the board below renders only when there are tiles. So
 * an empty board is the natural new-user state — no seeding required.
 *
 * `createStarterBoard` is offered explicitly via the "Use starter layout"
 * affordance in edit mode for users who want a head start. All tiles in
 * the starter render real Studio data — no mocks.
 */

import { type AgentSeedId, agentCardType, getAgentSeed } from "./agent-seeds";
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

function agentTile(
  agentId: AgentSeedId,
  pos: { x: number; y: number },
  sizeKey: keyof typeof SIZE_PRESETS,
): TileInstance {
  const seed = getAgentSeed(agentId);
  return tile(agentCardType(agentId), pos, sizeKey, {
    templateId: agentId,
    title: seed.title,
    icon: seed.icon,
    description: seed.description,
  });
}

export function createEmptyBoard(): HomeBoard {
  return { version: 3, tiles: [] };
}

export function createStarterBoard(): HomeBoard {
  // 3-col bento, real-data only.
  //   row 0:   Site Editor (S)    | Image Creator (S)   | Web Researcher (S)
  //   row 1–2: Recent tasks (M)   | Workspace stats (XL)
  //   row 3:   Connections (W)
  return {
    version: 3,
    tiles: [
      agentTile("site-editor", { x: 0, y: 0 }, "S"),
      agentTile("ai-image", { x: 1, y: 0 }, "S"),
      agentTile("ai-research", { x: 2, y: 0 }, "S"),
      tile("studio.recent-tasks", { x: 0, y: 1 }, "M"),
      tile("studio.stats", { x: 1, y: 1 }, "XL"),
      tile("studio.connections-overview", { x: 0, y: 3 }, "W"),
    ],
  };
}
