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
import { useSyncExternalStore } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/web/lib/agent-capabilities";
import { useChatTask } from "@/web/components/chat/index";
import { useThreadManager } from "@/web/components/chat/store/hooks";
import { getActiveGithubRepo } from "@/web/lib/github-repo.ts";
import { usePrByBranch } from "@/web/components/thread/github/use-pr-data.ts";
import type {
  ThreadExpandedTool,
  ThreadMetadata,
} from "../../../storage/types";
import type { Task } from "@/web/components/chat/task/types";
import {
  formatPinnedViewTabId,
  parseAutomationTabId,
  resolveActiveTabAndOpen,
  resolveDefaultTabId,
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
  const manager = useThreadManager();
  // Subscribe to the store so a row that lands AFTER first render (snapshot
  // arrives late, manager.create prepends, etc.) re-renders this hook with
  // fresh metadata. Reading via the queryFn alone would pin a stale null in
  // the React Query cache.
  const threads = useSyncExternalStore(
    manager.threads.subscribe,
    manager.threads.get,
  );
  const localHit = taskId
    ? (threads.find((t) => t.id === taskId) ?? null)
    : null;
  // Suspense fallback for the archived-thread / cold-load case — not in the
  // open-list snapshot, so the store can't help. Result is cached per
  // `KEYS.ensureTask(orgId, taskId)`; localHit always wins when present, so a
  // stale-null cache entry is harmless once the store catches up.
  const { data: fetchedMetadata } = useSuspenseQuery<
    Task | null,
    Error,
    ThreadMetadata | null
  >({
    queryKey: KEYS.ensureTask(org.id, taskId),
    queryFn: async () => {
      if (!taskId || !client) return null;
      try {
        const result = (await client.callTool({
          name: "COLLECTION_THREADS_GET",
          arguments: { id: taskId },
        })) as { structuredContent?: unknown };
        const payload = (result.structuredContent ?? result) as {
          item?: Task | null;
        };
        return payload.item ?? null;
      } catch {
        return null;
      }
    },
    select: (task) => task?.metadata ?? null,
    staleTime: 30_000,
  });
  return localHit?.metadata ?? fetchedMetadata ?? null;
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
  const { org } = useProjectContext();
  const { currentBranch } = useChatTask();

  const githubRepo = getActiveGithubRepo(entity);
  const prQuery = usePrByBranch({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId: githubRepo?.connectionId ?? "",
    owner: githubRepo?.owner ?? "",
    repo: githubRepo?.name ?? "",
    branch: githubRepo ? currentBranch : null,
  });
  const hasOpenPr = prQuery.data?.state === "open";

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
  const hasActiveGithubRepo = agentHasConnectedGithub(entity);
  const hasClonableSource = agentHasClonableSource(entity?.metadata);
  const connections = useConnections({ includeVirtual: true });

  const { activeTab: rawActiveTab, mainOpen: rawMainOpen } =
    resolveActiveTabAndOpen({
      mainParam: search.main,
      metadata: entityLayout
        ? {
            defaultMainView: entityLayout.defaultMainView ?? null,
            tabs: layoutTabs.map((t) => ({ id: t.id })),
          }
        : null,
    });

  const gitTabVisible =
    hasActiveGithubRepo &&
    (hasOpenPr || (prQuery.isPending && rawActiveTab === "git"));
  const activeTab =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? resolveDefaultTabId(
          entityLayout
            ? {
                defaultMainView: entityLayout.defaultMainView ?? null,
                tabs: layoutTabs.map((t) => ({ id: t.id })),
              }
            : null,
        )
      : rawActiveTab;
  const mainOpen =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? false
      : rawMainOpen;

  const automationTabParsed = parseAutomationTabId(activeTab);

  // Unified "settings" tab bundles instructions, connections, and layout
  // into a single detail view. On GitHub-linked vMCPs the contextual
  // work tabs (Preview, git) come first so they're closest to the panel;
  // Settings + Automations stay anchored at the right.
  const systemTabs: Array<{ id: string; title: string }> = [];
  if (hasClonableSource) {
    systemTabs.push({ id: "preview", title: "Preview" });
  }
  if (gitTabVisible) {
    systemTabs.push({ id: "git", title: "Review changes" });
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
