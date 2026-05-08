/**
 * Static tile registry. Sizes use the 3-col grid:
 *   S 1×1, M 1×2, L 2×1, XL 2×2, W 3×1.
 */

import {
  BookOpen01,
  Clock,
  Server01,
  Star01,
  Stars01,
  TrendUp02,
  Users03,
} from "@untitledui/icons";
import { AGENT_SEEDS, agentCardType } from "./agent-seeds";
import type { TileDefinition } from "./types";
import {
  AgentCardTile,
  ConnectionsOverviewTile,
  NotesTile,
  RecentAgentsTile,
  RecentTasksTile,
  ShortcutsTile,
  StatsTile,
  UnknownTile,
  WelcomeTile,
} from "./renderers";

const STUDIO_AGENT_SOURCE = {
  source: "agent",
  sourceId: "studio-agent",
} as const;

const AGENT_CARD_ENTRIES: TileDefinition[] = AGENT_SEEDS.map((a) => ({
  type: agentCardType(a.id),
  source: "agent",
  sourceId: a.id,
  title: a.title,
  description: a.description,
  icon: <Users03 size={14} />,
  category: "agents",
  supportedSizes: ["S", "M", "L", "XL"],
  defaultSize: "S",
  defaultConfig: {
    templateId: a.id,
    title: a.title,
    icon: a.icon,
    description: a.description,
  },
  render: AgentCardTile,
}));

export const TILE_CATALOG: TileDefinition[] = [
  ...AGENT_CARD_ENTRIES,
  {
    type: "studio.welcome",
    source: "system",
    title: "Welcome",
    description: "Greeting and quick actions for your workspace.",
    icon: <Stars01 size={14} />,
    category: "essentials",
    supportedSizes: ["W", "L"],
    defaultSize: "W",
    render: WelcomeTile,
  },
  {
    type: "studio.recent-agents",
    ...STUDIO_AGENT_SOURCE,
    title: "Recent agents",
    description: "Jump back into agents you've used recently.",
    icon: <Users03 size={14} />,
    category: "shortcuts",
    supportedSizes: ["S", "M", "L", "XL"],
    defaultSize: "M",
    render: RecentAgentsTile,
  },
  {
    type: "studio.recent-tasks",
    ...STUDIO_AGENT_SOURCE,
    title: "Recent tasks",
    description: "Your in-progress conversations.",
    icon: <Clock size={14} />,
    category: "activity",
    supportedSizes: ["S", "M", "L", "XL"],
    defaultSize: "M",
    render: RecentTasksTile,
  },
  {
    type: "studio.connections-overview",
    ...STUDIO_AGENT_SOURCE,
    title: "Connections",
    description: "Status and grid of your connected MCPs.",
    icon: <Server01 size={14} />,
    category: "stats",
    supportedSizes: ["S", "M", "L", "XL"],
    defaultSize: "L",
    render: ConnectionsOverviewTile,
  },
  {
    type: "studio.shortcuts",
    source: "system",
    title: "Shortcuts",
    description: "Pinned destinations inside your workspace.",
    icon: <Star01 size={14} />,
    category: "shortcuts",
    supportedSizes: ["M", "L", "XL", "W"],
    defaultSize: "L",
    render: ShortcutsTile,
  },
  {
    type: "studio.notes",
    source: "system",
    title: "Notes",
    description: "A scratchpad just for you.",
    icon: <BookOpen01 size={14} />,
    category: "essentials",
    supportedSizes: ["S", "M", "L", "XL", "W"],
    defaultSize: "M",
    render: NotesTile,
  },
  {
    type: "studio.stats",
    ...STUDIO_AGENT_SOURCE,
    title: "Workspace stats",
    description: "Live counts of agents, connections, and errors.",
    icon: <TrendUp02 size={14} />,
    category: "stats",
    supportedSizes: ["S", "M", "L", "XL"],
    defaultSize: "S",
    render: StatsTile,
  },
];

const BY_TYPE = new Map(TILE_CATALOG.map((t) => [t.type, t]));

export function getTileDefinition(type: string): TileDefinition | undefined {
  return BY_TYPE.get(type);
}

export function renderTileContent(
  type: string,
  props: Parameters<TileDefinition["render"]>[0],
) {
  const def = getTileDefinition(type);
  const Renderer = def?.render ?? UnknownTile;
  return <Renderer {...props} />;
}

export const CATEGORY_LABELS: Record<string, string> = {
  essentials: "Essentials",
  agents: "Agents",
  activity: "Activity",
  stats: "Stats",
  shortcuts: "Shortcuts",
  data: "Data",
  workflow: "Workflows",
};

export const CATEGORY_ORDER: TileDefinition["category"][] = [
  "essentials",
  "agents",
  "activity",
  "stats",
  "shortcuts",
  "data",
  "workflow",
];
