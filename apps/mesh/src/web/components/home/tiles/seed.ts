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

function agentTile(
  agentId: keyof typeof AGENT_SEEDS,
  pos: { x: number; y: number },
  sizeKey: keyof typeof SIZE_PRESETS,
): TileInstance {
  const seed = AGENT_SEEDS[agentId];
  const size = SIZE_PRESETS[sizeKey];
  return {
    id: newId(),
    type: `agent.card.${agentId}`,
    x: pos.x,
    y: pos.y,
    w: size.w,
    h: size.h,
    config: {
      templateId: agentId,
      title: seed.title,
      icon: seed.icon,
      description: seed.description,
    },
  };
}

const AGENT_SEEDS = {
  "site-editor": {
    title: "deco Site Editor",
    icon: "/logos/deco%20logo.svg#agentcolor=brand-green",
    description: "Edit and ship changes to your deco site, conversation-first.",
  },
  "ai-image": {
    title: "Image Creator",
    icon: "icon://Image01?color=rose",
    description: "Generate, edit, and iterate on visuals from a prompt.",
  },
  "ai-research": {
    title: "Web Researcher",
    icon: "icon://SearchMd?color=green",
    description: "Run multi-source web research and summarise the findings.",
  },
} as const;

export function createStarterBoard(): HomeBoard {
  // 3-col bento. A featured pair on top, agent cards in the middle,
  // then compact tiles at the bottom.
  //   row 0–1: Recent tasks (1×2)  | Reliability Agent (2×2)
  //   row 2:   Site Editor (S)     | Image Creator (S)   | Web Researcher (S)
  //   row 3:   Connections (2×1)                         | Stats (1×1)
  //   row 4:   GitHub (1×1)        | Linear (1×1)        | Today (1×1)
  return {
    version: 3,
    tiles: [
      tile("studio.recent-tasks", { x: 0, y: 0 }, "M"),
      tile("agent.reliability", { x: 1, y: 0 }, "XL"),
      agentTile("site-editor", { x: 0, y: 2 }, "S"),
      agentTile("ai-image", { x: 1, y: 2 }, "S"),
      agentTile("ai-research", { x: 2, y: 2 }, "S"),
      tile("studio.connections-overview", { x: 0, y: 3 }, "L"),
      tile("studio.stats", { x: 2, y: 3 }, "S"),
      tile("mock.github.activity", { x: 0, y: 4 }, "S"),
      tile("mock.linear.issues", { x: 1, y: 4 }, "S"),
      tile("mock.calendar.upcoming", { x: 2, y: 4 }, "S"),
    ],
  };
}
