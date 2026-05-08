/**
 * Shared hook for the main-panel tab system.
 *
 * Assembles all tab sources (system + agent-declared + task-expanded +
 * ephemeral automation), resolves the active tab from the URL, and
 * returns a click-aware `setActiveTab` that implements tab-as-toggle
 * semantics via `resolveTabClickTarget`.
 *
 * Both the header tab bar and the main-panel content call this hook
 * independently; `useVirtualMCP` / `useSuspenseQuery` dedupe the reads.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useChatTask } from "@/web/components/chat/index";
import type {
  ThreadExpandedTool,
  ThreadMetadata,
} from "../../../storage/types";
import {
  formatPinnedViewTabId,
  parseAutomationTabId,
  resolveActiveTabAndOpen,
  resolveTabClickTarget,
  type AutomationTabParsed,
} from "./tab-id";
import { resolveTabIcon, type TabIcon, type TabKind } from "./resolve-tab-icon";

export type AgentTabDef = {
  id: string;
  title: string;
  view: {
    type: "ext-app";
    appId: string;
    args?: Record<string, unknown>;
  };
};

export type Tab = {
  id: string;
  title: string;
  icon: TabIcon;
  kind: TabKind;
};

export interface MainPanelTabs {
  activeTab: string;
  mainOpen: boolean;
  setActiveTab: (id: string) => void;
  systemTabs: Array<{ id: string; title: string }>;
  layoutTabs: AgentTabDef[];
  expandedTools: ThreadExpandedTool[];
  automationTabParsed: AutomationTabParsed | null;
  tabs: Tab[];
}

function useTaskMetadata(taskId: string): ThreadMetadata | null {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useSuspenseQuery({
    queryKey: KEYS.threadMetadata(taskId),
    queryFn: async () => {
      if (!client || !taskId) return null;
      try {
        const result = (await client.callTool({
          name: "COLLECTION_THREADS_GET",
          arguments: { id: taskId },
        })) as { structuredContent?: unknown };
        const payload = (result.structuredContent ?? result) as {
          item?: { metadata?: ThreadMetadata } | null;
        };
        return payload.item?.metadata ?? null;
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
  });
  return data;
}

export function useMainPanelTabs(ctx: {
  virtualMcpId: string;
  taskId: string;
}): MainPanelTabs {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    main?: string;
  };
  const entity = useVirtualMCP(ctx.virtualMcpId);
  const metadata = useTaskMetadata(ctx.taskId);
  const { currentBranch } = useChatTask();

  const entityUI =
    (
      entity?.metadata as {
        ui?: {
          pinnedViews?: Array<{
            connectionId: string;
            toolName: string;
            label: string;
            icon?: string | null;
          }> | null;
          layout?: {
            tabs?: AgentTabDef[];
            defaultMainView?: {
              type: string;
              id?: string;
              toolName?: string;
            } | null;
          };
        };
      } | null
    )?.ui ?? null;

  const entityLayout = entityUI?.layout ?? null;
  const layoutTabs = (entityLayout?.tabs ?? []) as AgentTabDef[];
  const pinnedViews = entityUI?.pinnedViews ?? [];
  const expandedTools: ThreadExpandedTool[] = metadata?.expanded_tools ?? [];
  const hasActiveGithubRepo = !!(entity && getActiveGithubRepo(entity));
  const connections = useConnections({ includeVirtual: true });

  const { activeTab, mainOpen } = resolveActiveTabAndOpen({
    mainParam: search.main,
    metadata: entityLayout
      ? {
          defaultMainView: entityLayout.defaultMainView ?? null,
          tabs: layoutTabs.map((t) => ({ id: t.id })),
        }
      : null,
  });

  const automationTabParsed = parseAutomationTabId(activeTab);

  // Unified "settings" tab bundles instructions, connections, and layout
  // into a single detail view. On GitHub-linked vMCPs the contextual
  // work tabs (Preview, Terminal, git) come first so they're closest
  // to the panel; Settings + Automations stay anchored at the right.
  const systemTabs: Array<{ id: string; title: string }> = [];
  if (hasActiveGithubRepo) {
    systemTabs.push({ id: "preview", title: "Preview" });
    systemTabs.push({ id: "env", title: "Terminal" });
    systemTabs.push({ id: "git", title: currentBranch ?? "git" });
  }
  systemTabs.push({ id: "settings", title: "Settings" });
  systemTabs.push({ id: "automations", title: "Automations" });

  // Merge pinned views + per-task expanded tools into a single list keyed
  // by the pinned-view tab id. Pinned views win on dedupe so the
  // virtual-MCP–configured label/icon survives even if the same tool was
  // later expanded from a chat message.
  const pinnedTabMap = new Map<
    string,
    {
      id: string;
      title: string;
      appId: string;
      iconKey: string;
      iconUrl?: string | null;
    }
  >();
  for (const t of expandedTools) {
    const id = formatPinnedViewTabId(t.appId, t.toolName);
    pinnedTabMap.set(id, {
      id,
      title: t.toolName,
      appId: t.appId,
      iconKey: t.toolName,
    });
  }
  for (const pv of pinnedViews) {
    const id = formatPinnedViewTabId(pv.connectionId, pv.toolName);
    pinnedTabMap.set(id, {
      id,
      title: pv.label || pv.toolName,
      appId: pv.connectionId,
      iconKey: pv.toolName,
      iconUrl: pv.icon ?? null,
    });
  }

  const tabs: Tab[] = [
    ...layoutTabs.map((t) => ({
      id: t.id,
      title: t.title,
      kind: "agent" as const,
      icon: resolveTabIcon({
        tabId: t.id,
        kind: "agent",
        appId: t.view.appId,
        connections,
      }),
    })),
    ...Array.from(pinnedTabMap.values()).map((t) => ({
      id: t.id,
      title: t.title,
      kind: "expanded" as const,
      icon: resolveTabIcon({
        tabId: t.iconKey,
        kind: "expanded",
        appId: t.appId,
        iconUrl: t.iconUrl,
        connections,
      }),
    })),
    ...systemTabs.map((t) => ({
      id: t.id,
      title: t.title,
      kind: "system" as const,
      icon: resolveTabIcon({
        tabId: t.id,
        kind: "system",
        connections,
      }),
    })),
  ];

  const setActiveTab = (id: string) => {
    const target = resolveTabClickTarget({
      clickedId: id,
      activeTab,
      mainOpen,
    });
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: target }),
      replace: true,
    });
  };

  return {
    activeTab,
    mainOpen,
    setActiveTab,
    systemTabs,
    layoutTabs,
    expandedTools,
    automationTabParsed,
    tabs,
  };
}
