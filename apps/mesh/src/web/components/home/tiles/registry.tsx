/**
 * Tile catalog. Sizes use the 3-col grid:
 *   S 1×1, M 1×2, L 2×1, XL 2×2, W 3×1.
 *
 * Static tiles ship with the app. The runtime catalog (used by the
 * Add-tile sheet) is a hook that merges the static set with dynamic
 * entries derived from the user's installed virtual MCPs — every
 * agent becomes a clickable card, and every layout tab / pinned view
 * the agent exposes becomes its own pinable tile.
 */

import { BookOpen01, Star01, Stars01 } from "@untitledui/icons";
import { useVirtualMCPs } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AGENT_SEEDS, STUDIO_AGENT, agentCardType } from "./agent-seeds";
import type { TileDefinition } from "./types";
import {
  AgentCardTile,
  AgentToolViewTile,
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
  sourceId: STUDIO_AGENT.id,
} as const;

const STUDIO_AGENT_ICON = (
  <AgentAvatar icon={STUDIO_AGENT.icon} name={STUDIO_AGENT.name} size="xs" />
);

const AGENT_TEMPLATE_ENTRIES: TileDefinition[] = AGENT_SEEDS.map((a) => ({
  type: agentCardType(a.id),
  source: "agent",
  sourceId: a.id,
  title: a.title,
  description: a.description,
  icon: <AgentAvatar icon={a.icon} name={a.title} size="xs" />,
  category: "agents",
  supportedSizes: ["S", "M", "L", "XL", "W", "B"],
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
  {
    type: "studio.welcome",
    source: "system",
    title: "Welcome",
    description: "Greeting and quick actions for your workspace.",
    icon: <Stars01 size={14} />,
    category: "essentials",
    supportedSizes: ["W", "B", "L"],
    defaultSize: "W",
    render: WelcomeTile,
  },
  {
    type: "studio.recent-tasks",
    ...STUDIO_AGENT_SOURCE,
    title: "Recent tasks",
    description: "Your in-progress conversations.",
    icon: STUDIO_AGENT_ICON,
    category: "studio",
    supportedSizes: ["S", "M", "L", "XL", "W", "B"],
    defaultSize: "M",
    render: RecentTasksTile,
  },
  {
    type: "studio.recent-agents",
    ...STUDIO_AGENT_SOURCE,
    title: "Recent agents",
    description: "Jump back into agents you've used recently.",
    icon: STUDIO_AGENT_ICON,
    category: "studio",
    supportedSizes: ["S", "M", "L", "XL", "W", "B"],
    defaultSize: "M",
    render: RecentAgentsTile,
  },
  {
    type: "studio.connections-overview",
    ...STUDIO_AGENT_SOURCE,
    title: "Connections",
    description: "Status and grid of your connected MCPs.",
    icon: STUDIO_AGENT_ICON,
    category: "studio",
    supportedSizes: ["S", "M", "L", "XL", "W", "B"],
    defaultSize: "L",
    render: ConnectionsOverviewTile,
  },
  {
    type: "studio.stats",
    ...STUDIO_AGENT_SOURCE,
    title: "Workspace stats",
    description: "Live counts of agents, connections, and errors.",
    icon: STUDIO_AGENT_ICON,
    category: "studio",
    supportedSizes: ["S", "M", "L", "XL", "W", "B"],
    defaultSize: "S",
    render: StatsTile,
  },
  ...AGENT_TEMPLATE_ENTRIES,
  {
    type: "studio.shortcuts",
    source: "system",
    title: "Shortcuts",
    description: "Pinned destinations inside your workspace.",
    icon: <Star01 size={14} />,
    category: "shortcuts",
    supportedSizes: ["M", "L", "XL", "W", "B"],
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
    supportedSizes: ["S", "M", "L", "XL", "W", "B"],
    defaultSize: "M",
    render: NotesTile,
  },
];

const BY_TYPE = new Map(TILE_CATALOG.map((t) => [t.type, t]));

/**
 * Tile types created at runtime (one per installed agent / agent tool
 * view) aren't in the static catalog, but pinned instances reference
 * them by their full type string. Match on the prefix and return a
 * minimal synthetic def so TileSlot can route to the right renderer
 * even after a reload.
 */
function getDynamicTileDefinition(type: string): TileDefinition | undefined {
  if (type.startsWith("agent.tool-view.")) {
    return {
      type,
      source: "agent",
      title: "Agent view",
      description: "",
      icon: null,
      category: "agents",
      supportedSizes: ["S", "M", "L", "XL", "W", "B"],
      defaultSize: "M",
      render: AgentToolViewTile,
    };
  }
  if (type.startsWith("agent.card.installed.")) {
    return {
      type,
      source: "agent",
      title: "Agent",
      description: "",
      icon: null,
      category: "agents",
      supportedSizes: ["S", "M", "L", "XL", "W", "B"],
      defaultSize: "S",
      render: AgentCardTile,
    };
  }
  return undefined;
}

export function getTileDefinition(type: string): TileDefinition | undefined {
  return BY_TYPE.get(type) ?? getDynamicTileDefinition(type);
}

export function renderTileContent(
  type: string,
  props: Parameters<TileDefinition["render"]>[0],
) {
  const def = getTileDefinition(type);
  const Renderer = def?.render ?? UnknownTile;
  return <Renderer {...props} />;
}

interface AgentToolView {
  /** "tab:<tabId>" — the agent's own declared tabs */
  mainTabId: string;
  label: string;
  icon: string | null | undefined;
}

interface AgentLayoutMeta {
  ui?: {
    layout?: { tabs?: AgentToolView[] | undefined } | null;
    pinnedViews?:
      | {
          connectionId: string;
          toolName: string;
          label: string;
          icon?: string | null;
        }[]
      | null;
  } | null;
}

/**
 * Hook variant of `TILE_CATALOG` — merges static tiles with one entry
 * per installed agent, plus one entry per UI view that agent exposes
 * (layout tabs and pinned tool views). The Add-tile sheet uses this
 * so users see their own agents and their UIs as pinnable tiles.
 */
export function useTileCatalog(): TileDefinition[] {
  const installed = useVirtualMCPs();

  const installedAgentEntries: TileDefinition[] = [];
  const installedToolViewEntries: TileDefinition[] = [];

  for (const agent of installed) {
    if (!agent.id || agent.status !== "active") continue;
    const meta = agent.metadata as AgentLayoutMeta | undefined;
    const description = agent.description ?? "Open a chat with this agent.";
    const iconString = agent.icon ?? "";

    installedAgentEntries.push({
      type: `agent.card.installed.${agent.id}`,
      source: "agent",
      sourceId: agent.id,
      title: agent.title,
      description,
      icon: <AgentAvatar icon={iconString} name={agent.title} size="xs" />,
      category: "agents",
      supportedSizes: ["S", "M", "L", "XL", "W", "B"],
      defaultSize: "S",
      defaultConfig: {
        agentId: agent.id,
        title: agent.title,
        icon: iconString,
        description,
      },
      render: AgentCardTile,
    });

    const tabs = meta?.ui?.layout?.tabs ?? [];
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object") continue;
      const tabId = (tab as { id?: string }).id;
      const tabTitle = (tab as { title?: string }).title;
      const tabView = (
        tab as {
          view?: { appId?: string; args?: Record<string, unknown> };
        }
      ).view;
      const connectionId = tabView?.appId;
      if (!tabId || !tabTitle || !connectionId) continue;
      installedToolViewEntries.push({
        type: `agent.tool-view.${agent.id}.${tabId}`,
        source: "agent",
        sourceId: agent.id,
        title: `${agent.title} — ${tabTitle}`,
        description: `Open the ${tabTitle} view from ${agent.title}.`,
        icon: <AgentAvatar icon={iconString} name={agent.title} size="xs" />,
        category: "agents",
        supportedSizes: ["L", "XL", "W", "B"],
        defaultSize: "XL",
        defaultConfig: {
          agentId: agent.id,
          agentTitle: agent.title,
          agentIcon: iconString,
          mainTabId: tabId,
          viewLabel: tabTitle,
          // The chat surface binds the layout tab to its tool by
          // (connectionId = view.appId, toolName = tab.id). Same
          // mapping here so the renderer can call the right tool.
          connectionId,
          toolName: tabId,
          args: tabView?.args,
        },
        render: AgentToolViewTile,
      });
    }

    const pinned = meta?.ui?.pinnedViews ?? [];
    for (const view of pinned) {
      if (!view) continue;
      const tabId = `app:${view.connectionId}:${view.toolName}`;
      installedToolViewEntries.push({
        type: `agent.tool-view.${agent.id}.${tabId}`,
        source: "agent",
        sourceId: agent.id,
        title: `${agent.title} — ${view.label}`,
        description: `Open the ${view.label} view from ${agent.title}.`,
        icon: <AgentAvatar icon={iconString} name={agent.title} size="xs" />,
        category: "agents",
        supportedSizes: ["L", "XL", "W", "B"],
        defaultSize: "XL",
        defaultConfig: {
          agentId: agent.id,
          agentTitle: agent.title,
          agentIcon: iconString,
          mainTabId: tabId,
          viewLabel: view.label,
          viewIcon: view.icon ?? null,
          connectionId: view.connectionId,
          toolName: view.toolName,
        },
        render: AgentToolViewTile,
      });
    }
  }

  return [
    ...TILE_CATALOG,
    ...installedAgentEntries,
    ...installedToolViewEntries,
  ];
}

export const CATEGORY_LABELS: Record<string, string> = {
  essentials: "Essentials",
  studio: "Studio Agent",
  agents: "Agents",
  activity: "Activity",
  stats: "Stats",
  shortcuts: "Shortcuts",
  data: "Data",
  workflow: "Workflows",
};

export const CATEGORY_ORDER: TileDefinition["category"][] = [
  "essentials",
  "studio",
  "agents",
  "activity",
  "stats",
  "shortcuts",
  "data",
  "workflow",
];
