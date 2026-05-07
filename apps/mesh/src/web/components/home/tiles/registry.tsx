/**
 * Static tile registry. The catalog UI iterates over `TILE_CATALOG`;
 * the board renderer looks up by `type` via `getTileDefinition`.
 *
 * When tile contributions from MCP apps land, this becomes a hook that
 * merges static + dynamic definitions. Today every entry ships with the
 * app and the icons are mocked.
 */

import {
  AlertCircle,
  BookOpen01,
  Calendar,
  GitBranch01,
  Globe02,
  Lightning01,
  Server01,
  Star01,
  Stars01,
  Clock,
  TrendUp02,
  Users03,
} from "@untitledui/icons";
import type { TileDefinition } from "./types";
import {
  AnalyticsChartTile,
  CalendarTile,
  ConnectionsOverviewTile,
  GithubActivityTile,
  LinearIssuesTile,
  NotesTile,
  QuickChatTile,
  RecentAgentsTile,
  RecentTasksTile,
  ShortcutsTile,
  StatsTile,
  UnknownTile,
  WelcomeTile,
} from "./renderers";

export const TILE_CATALOG: TileDefinition[] = [
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
    source: "system",
    title: "Recent agents",
    description: "Jump back into agents you've used recently.",
    icon: <Users03 size={14} />,
    category: "shortcuts",
    supportedSizes: ["S", "M", "L"],
    defaultSize: "M",
    render: RecentAgentsTile,
  },
  {
    type: "studio.recent-tasks",
    source: "system",
    title: "Recent tasks",
    description: "Your in-progress conversations.",
    icon: <Clock size={14} />,
    category: "activity",
    supportedSizes: ["S", "M", "L"],
    defaultSize: "M",
    render: RecentTasksTile,
  },
  {
    type: "studio.quick-chat",
    source: "system",
    title: "Quick chat",
    description: "A compact composer pinned to your home.",
    icon: <Lightning01 size={14} />,
    category: "essentials",
    supportedSizes: ["M", "L", "W"],
    defaultSize: "L",
    render: QuickChatTile,
  },
  {
    type: "studio.connections-overview",
    source: "system",
    title: "Connections",
    description: "Status and grid of your connected MCPs.",
    icon: <Server01 size={14} />,
    category: "stats",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: ConnectionsOverviewTile,
  },
  {
    type: "studio.shortcuts",
    source: "system",
    title: "Shortcuts",
    description: "Pinned destinations inside your workspace.",
    icon: <Star01 size={14} />,
    category: "shortcuts",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: ShortcutsTile,
  },
  {
    type: "studio.notes",
    source: "system",
    title: "Notes",
    description: "A scratchpad just for you.",
    icon: <BookOpen01 size={14} />,
    category: "essentials",
    supportedSizes: ["S", "M", "L"],
    defaultSize: "M",
    render: NotesTile,
  },
  {
    type: "studio.stats",
    source: "system",
    title: "Workspace stats",
    description: "KPIs for tasks, tools, and tokens.",
    icon: <TrendUp02 size={14} />,
    category: "stats",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: StatsTile,
  },
  {
    type: "mock.github.activity",
    source: "mcp",
    sourceId: "mock-github",
    title: "GitHub activity",
    description: "Recent commits across your repos. (Mocked)",
    icon: <GitBranch01 size={14} />,
    category: "activity",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: GithubActivityTile,
  },
  {
    type: "mock.linear.issues",
    source: "mcp",
    sourceId: "mock-linear",
    title: "Linear issues",
    description: "Issues assigned to you. (Mocked)",
    icon: <AlertCircle size={14} />,
    category: "workflow",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: LinearIssuesTile,
  },
  {
    type: "mock.calendar.upcoming",
    source: "mcp",
    sourceId: "mock-google-calendar",
    title: "Today's calendar",
    description: "Your next meetings. (Mocked)",
    icon: <Calendar size={14} />,
    category: "activity",
    supportedSizes: ["S", "M"],
    defaultSize: "M",
    render: CalendarTile,
  },
  {
    type: "mock.analytics.chart",
    source: "mcp",
    sourceId: "mock-analytics",
    title: "Page views",
    description: "Traffic over the last 24h. (Mocked)",
    icon: <Globe02 size={14} />,
    category: "data",
    supportedSizes: ["M", "L"],
    defaultSize: "M",
    render: AnalyticsChartTile,
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
  if (!def) return <UnknownTile {...props} />;
  return def.render(props);
}

export const CATEGORY_LABELS: Record<string, string> = {
  essentials: "Essentials",
  activity: "Activity",
  stats: "Stats",
  shortcuts: "Shortcuts",
  data: "Data",
  workflow: "Workflows",
};

export const CATEGORY_ORDER: TileDefinition["category"][] = [
  "essentials",
  "activity",
  "stats",
  "shortcuts",
  "data",
  "workflow",
];
