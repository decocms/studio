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
    tasks: [
      { id: "se-1", title: "Refresh hero copy", status: "in-progress" },
      { id: "se-2", title: "Wire up new pricing page", status: "review" },
      { id: "se-3", title: "Patch missing OG images", status: "in-progress" },
    ],
  },
  "ai-image": {
    title: "Image Creator",
    icon: "icon://Image01?color=rose",
    description: "Generate, edit, and iterate on visuals from a prompt.",
    tasks: [
      {
        id: "ai-1",
        title: "Generating: 'launch banner'",
        status: "in-progress",
      },
    ],
  },
  "ai-research": {
    title: "Web Researcher",
    icon: "icon://SearchMd?color=green",
    description: "Run multi-source web research and summarise the findings.",
  },
} as const;

export function createStarterBoard(): HomeBoard {
  // 3-col bento. Agents are the headline at the top — clickable cards
  // showing live activity if they have any. Below that, the dashboard
  // tiles.
  //   row 0–1: Site Editor (1×2)  | Image Creator (1×2) | Web Researcher (1×2)
  //   row 2–3: Recent tasks (1×2) | Reliability Agent (2×2)
  //   row 4:   Connections (2×1)                        | Stats (1×1)
  //   row 5:   GitHub (1×1)       | Linear (1×1)        | Today (1×1)
  return {
    version: 3,
    tiles: [
      agentTile("site-editor", { x: 0, y: 0 }, "M"),
      agentTile("ai-image", { x: 1, y: 0 }, "M"),
      agentTile("ai-research", { x: 2, y: 0 }, "M"),
      tile("studio.recent-tasks", { x: 0, y: 2 }, "M"),
      tile("agent.reliability", { x: 1, y: 2 }, "XL"),
      tile("studio.connections-overview", { x: 0, y: 4 }, "L"),
      tile("studio.stats", { x: 2, y: 4 }, "S"),
      tile("mock.github.activity", { x: 0, y: 5 }, "S"),
      tile("mock.linear.issues", { x: 1, y: 5 }, "S"),
      tile("mock.calendar.upcoming", { x: 2, y: 5 }, "S"),
    ],
  };
}
