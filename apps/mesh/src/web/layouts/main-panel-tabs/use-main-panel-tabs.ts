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
import { Globe01, Monitor01 } from "@untitledui/icons";
import { createElement, useSyncExternalStore } from "react";
import {
  getDevConnectionId,
  useConnections,
  useMCPClientOptional,
  useMCPToolsListQuery,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { getUIResourceUri } from "@/mcp-apps/types";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
  findDevPartner,
} from "@/web/lib/agent-capabilities";
import { useChatTask } from "@/web/components/chat/index";
import { useThreadManager } from "@/web/components/chat/store/hooks";
import { getActiveGithubRepo } from "@/web/lib/github-repo.ts";
import { usePrByBranch } from "@/web/components/thread/github/use-pr-data.ts";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import { hasEditableDecoContent } from "@/web/components/sections-editor/page-list";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useCapability } from "@/web/hooks/use-capability";
import type {
  ThreadExpandedTool,
  ThreadMetadata,
} from "../../../storage/types";
import type { Task } from "@/web/components/chat/task/types";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import {
  formatPinnedViewTabId,
  parseAutomationTabId,
  parseDeckTabId,
  parseFileTabId,
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
  const studio = useStudioTools();
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
      if (!taskId) return null;
      try {
        const { item } = await studio.call("COLLECTION_THREADS_GET", {
          id: taskId,
        });
        return (item as Task | null) ?? null;
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
  const allAgents = useVirtualMCPs();
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

  // Fallback view source for a dev agent: inherit the LIVE partner's pinned
  // views (rewritten to the dev connection) when paired. Superseded below by
  // auto-detection from the dev server's own MCP app when its sandbox is up —
  // so an unpaired, freshly-imported MCP app still surfaces its views.
  const devPartner = findDevPartner(entity ?? null, allAgents);
  const livePartner =
    devPartner?.mode === "dev"
      ? ((allAgents ?? []).find((a) => a.id === devPartner.targetId) ?? null)
      : null;
  const liveUI =
    (
      livePartner?.metadata as {
        ui?: {
          pinnedViews?: Array<{
            connectionId: string;
            toolName: string;
            label: string;
            icon?: string | null;
          }> | null;
          layout?: {
            defaultMainView?: {
              type: string;
              id?: string;
              toolName?: string;
            } | null;
          };
        };
      } | null
    )?.ui ?? null;
  const devConnId = entity?.id ? getDevConnectionId(entity.id) : null;
  const livePinned = liveUI?.pinnedViews ?? [];
  const inheritsLiveViews =
    !!livePartner && !!devConnId && livePinned.length > 0;

  const basePinnedViews =
    inheritsLiveViews && devConnId
      ? livePinned.map((v) => ({ ...v, connectionId: devConnId }))
      : (entityUI?.pinnedViews ?? []);
  const baseDefaultMainView =
    inheritsLiveViews && devConnId && liveUI?.layout?.defaultMainView
      ? { ...liveUI.layout.defaultMainView, id: devConnId }
      : (entityLayout?.defaultMainView ?? null);
  const expandedTools: ThreadExpandedTool[] = metadata?.expanded_tools ?? [];
  const hasActiveGithubRepo = agentHasConnectedGithub(entity);
  const hasClonableSource = agentHasClonableSource(entity?.metadata);
  const { granted: canManageAgents } = useCapability("agents:manage");
  const connections = useConnections({ includeVirtual: true });

  // Show "Content" only when decofile/meta confirm editable pages or sections
  // — same rule as Preview's Sections editor toggle. Fetch only after the dev
  // server is up (shared query keys with Preview / Content). Requires
  // SandboxEventsProvider (desktop tabs bar lives inside VmEventsBridge).
  const vmEvents = useSandboxEvents();
  const devServerReady = vmEvents.lifecycle.phase === "running";

  // Auto-detect the dev MCP app's views straight from its sandbox dev server:
  // every tool that declares a `ui://` resource is a view, rendered against the
  // ephemeral dev connection (`dev_<id>`). No pairing / curated pinnedViews
  // needed — the dev server describes itself. Only queried once the dev server
  // is up (its `/api/mcp` serves tools); supersedes the inherited-live fallback.
  const devClient = useMCPClientOptional({
    connectionId: devConnId ?? undefined,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data: devToolsResult } = useMCPToolsListQuery({
    client: devClient as NonNullable<typeof devClient>,
    enabled: !!devClient && devServerReady,
  });
  const devViews =
    devConnId && devServerReady
      ? (devToolsResult?.tools ?? [])
          .filter((t) => !!getUIResourceUri(t._meta))
          .map((t) => ({
            connectionId: devConnId,
            toolName: t.name,
            label: toTitleCase(t.name),
            icon: null as string | null,
          }))
      : [];
  const firstDevView = devViews[0];
  const pinnedViews = firstDevView ? devViews : basePinnedViews;
  const effectiveDefaultMainView =
    firstDevView && devConnId
      ? { type: "ext-apps", id: devConnId, toolName: firstDevView.toolName }
      : baseDefaultMainView;
  const decofileFetchParams =
    hasClonableSource && entity?.id && currentBranch
      ? { orgSlug: org.slug, virtualMcpId: entity.id, branch: currentBranch }
      : null;
  // Subscribe to the same query keys as Preview; only fetch after the dev
  // server is running, but still re-render when Preview warms the cache.
  const { data: decofile } = useDecofile(decofileFetchParams, {
    fetchEnabled: devServerReady,
  });
  const { data: meta } = useLiveMeta(decofileFetchParams, {
    fetchEnabled: devServerReady,
  });
  const showContentTab = hasEditableDecoContent(decofile, meta);

  const { activeTab: rawActiveTab, mainOpen: rawMainOpen } =
    resolveActiveTabAndOpen({
      mainParam: search.main,
      metadata:
        effectiveDefaultMainView || entityLayout
          ? {
              defaultMainView: effectiveDefaultMainView,
              tabs: layoutTabs.map((t) => ({ id: t.id })),
            }
          : null,
    });

  const gitTabVisible =
    hasActiveGithubRepo &&
    (hasOpenPr || (prQuery.isPending && rawActiveTab === "git"));
  const layoutForDefault =
    effectiveDefaultMainView || entityLayout
      ? {
          defaultMainView: effectiveDefaultMainView,
          tabs: layoutTabs.map((t) => ({ id: t.id })),
        }
      : null;
  const activeTab =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? resolveDefaultTabId(layoutForDefault)
      : rawActiveTab === "content" && !showContentTab
        ? resolveDefaultTabId(layoutForDefault)
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
    if (showContentTab) {
      systemTabs.push({ id: "content", title: "Content" });
    }
  }
  if (gitTabVisible) {
    systemTabs.push({ id: "git", title: "Review changes" });
  }
  if (canManageAgents) {
    systemTabs.push({ id: "settings", title: "Settings" });
  }
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

  // Ephemeral file-preview tab (`?main=file:<key>`): surfaces as a pill
  // while open — like the Figma artifact pill — so the open file is
  // visible in the bar and click-to-toggle closes it. Not persisted:
  // once closed, recovery is via the chat's file rows / files panel.
  const fileTabParsed = parseFileTabId(activeTab);
  const fileTabName = fileTabParsed
    ? (fileTabParsed.key.split("/").pop() ?? fileTabParsed.key)
    : null;
  const fileTabs: Tab[] = fileTabName
    ? [
        {
          id: activeTab,
          title: fileTabName,
          kind: "file",
          icon: {
            kind: "component",
            Component: (props) =>
              createElement(FileTypeIcon, { filename: fileTabName, ...props }),
          },
        },
      ]
    : [];

  // Ephemeral live-HTML preview tab (`?main=deck:<path>` — decks AND
  // standalone pages from the org home volume): same pill semantics as
  // file previews. Title is the file stem; icon follows the artifact dir.
  const deckTabParsed = parseDeckTabId(activeTab);
  const deckTabs: Tab[] = deckTabParsed
    ? [
        {
          id: activeTab,
          title: (
            deckTabParsed.path.split("/").pop() ?? deckTabParsed.path
          ).replace(/\.html$/i, ""),
          kind: "file",
          icon: {
            kind: "component",
            Component: (props) =>
              createElement(
                deckTabParsed.path.startsWith("pages/") ? Globe01 : Monitor01,
                props,
              ),
          },
        },
      ]
    : [];

  const tabs: Tab[] = [
    ...fileTabs,
    ...deckTabs,
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
