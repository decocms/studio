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
} from "@decocms/mesh-sdk";
import { getUIResourceUri } from "@/mcp-apps/types";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/web/lib/agent-capabilities";
import { useChatTask } from "@/web/components/chat/index";
import { useThreadManager } from "@/web/components/chat/store/hooks";
import { getActiveGithubRepo } from "@/web/lib/github-repo.ts";
import { usePrByBranch } from "@/web/components/thread/github/use-pr-data.ts";
import { useDecofile } from "@/web/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/web/components/sections-editor/use-live-meta";
import { hasEditableDecoContent } from "@/web/components/sections-editor/page-list";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
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
  parseLibraryFileTabId,
  resolveActiveTabAndOpen,
  resolveDefaultTabId,
  resolveTabClickTarget,
  type AutomationTabParsed,
} from "./tab-id";
import { resolveTabIcon, type TabIcon, type TabKind } from "./resolve-tab-icon";
import { getSourceSystemTabs } from "./source-system-tabs";
import { useCapability } from "@/web/hooks/use-capability";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";

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
    main?: string | 0;
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

  // The ephemeral dev connection (`dev_<id>`) the agent's sandbox dev server is
  // served through. Its views are auto-detected from the dev server's own MCP
  // app below — no pairing / live-partner config involved.
  const devConnId = entity?.id ? getDevConnectionId(entity.id) : null;
  const expandedTools: ThreadExpandedTool[] = metadata?.expanded_tools ?? [];
  const hasActiveGithubRepo = agentHasConnectedGithub(entity);
  // A thread-scoped repo (bound by `load_repo`) makes the source tabs
  // (Preview, Code) available even when the agent itself has no repo — e.g.
  // the ephemeral Decopilot agent.
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(metadata);
  const { granted: canManageAgents } = useCapability("agents:manage");
  const reportsOnly = useReportsOnly();
  const connections = useConnections({ includeVirtual: true });

  // Show "Content" only when decofile/meta confirm editable pages or sections
  // — same rule as Preview's Sections editor toggle. Fetch only after the dev
  // server is up (shared query keys with Preview / Content). Requires
  // SandboxEventsProvider (desktop tabs bar lives inside VmEventsBridge).
  const vmEvents = useSandboxEvents();
  const { vmEntry, previewUrl } = useSandboxLifecycle();
  const devServerReady = vmEvents.lifecycle.phase === "running";

  // A user-desktop sandbox serves its dev server on a loopback previewUrl
  // (`http://<handle>.localhost`), which the cloud proxy cannot reach — so the
  // `dev_<id>` route resolves to a connection the pod can't fetch. The browser
  // IS co-located with the daemon, so point the dev MCP client straight at the
  // previewUrl (CORS on the deco dev server is `*`). For agent-sandbox the
  // previewUrl is public, so leave mcpUrl undefined and keep the cloud route.
  const devMcpUrl =
    vmEntry?.sandboxProviderKind === "user-desktop" && previewUrl
      ? `${previewUrl.replace(/\/+$/, "")}/api/mcp`
      : undefined;

  // Auto-detect the dev MCP app's views straight from its sandbox dev server:
  // every tool that declares a `ui://` resource is a view, rendered against the
  // ephemeral dev connection (`dev_<id>`). No pairing / curated pinnedViews
  // needed — the dev server describes itself. Only queried once the dev server
  // is up (its `/api/mcp` serves tools); when present, these override the live
  // agent's own pinned views below.
  const devClient = useMCPClientOptional({
    connectionId: devConnId ?? undefined,
    orgId: org.id,
    orgSlug: org.slug,
    mcpUrl: devMcpUrl,
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
  const pinnedViews = firstDevView ? devViews : (entityUI?.pinnedViews ?? []);
  const effectiveDefaultMainView =
    firstDevView && devConnId
      ? { type: "ext-apps", id: devConnId, toolName: firstDevView.toolName }
      : (entityLayout?.defaultMainView ?? null);
  const decofileFetchParams =
    hasClonableSource && entity?.id && currentBranch
      ? {
          orgSlug: org.slug,
          virtualMcpId: entity.id,
          branch: currentBranch,
          previewUrl,
        }
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
  // The Overview view (the Super Agent's default) leads the bar so it reads as
  // the agent's home. Data-driven off the configured default view — no
  // per-agent special-case. Source tabs (Preview · Code) share one capability
  // gate via getSourceSystemTabs; Blocks is an editing mode inside Preview.
  const leadingSystemTabs: Array<{ id: string; title: string }> = [];
  // Library / Tasks are agent-independent overlays; MainPanelTabsBar folds them
  // into the button row itself, so they are NOT part of this per-agent list.
  if (effectiveDefaultMainView?.type === "overview") {
    leadingSystemTabs.push({ id: "overview", title: "Overview" });
  }
  leadingSystemTabs.push(...getSourceSystemTabs(hasClonableSource));

  const systemTabs: Array<{ id: string; title: string }> = [];
  if (hasClonableSource && showContentTab) {
    systemTabs.push({ id: "content", title: "Content" });
  }
  if (gitTabVisible) {
    systemTabs.push({ id: "git", title: "Review changes" });
  }
  // Commerce (reports-only) orgs get a curated top bar: no Automations, no
  // Settings.
  if (!reportsOnly) {
    systemTabs.push({ id: "automations", title: "Automations" });
    if (canManageAgents) {
      systemTabs.push({ id: "settings", title: "Settings" });
    }
  }

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

  // Ephemeral Library file-preview tab (`?main=library-file:<path>`): an org
  // file referenced from a chat message, opened as a side panel on desktop.
  // Same pill semantics as file/deck previews; title is the basename.
  const libraryFileTabParsed = parseLibraryFileTabId(activeTab);
  const libraryFileName = libraryFileTabParsed
    ? (libraryFileTabParsed.path.split("/").pop() ?? libraryFileTabParsed.path)
    : null;
  const libraryFileTabs: Tab[] = libraryFileName
    ? [
        {
          id: activeTab,
          title: libraryFileName,
          kind: "file",
          icon: {
            kind: "component",
            Component: (props) =>
              createElement(FileTypeIcon, {
                filename: libraryFileName,
                ...props,
              }),
          },
        },
      ]
    : [];

  const tabs: Tab[] = [
    ...leadingSystemTabs.map((t) => ({
      id: t.id,
      title: t.title,
      kind: "system" as const,
      icon: resolveTabIcon({
        tabId: t.id,
        kind: "system",
        connections,
      }),
    })),
    ...fileTabs,
    ...deckTabs,
    ...libraryFileTabs,
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
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: target,
      }),
      replace: true,
    });
  };

  return {
    activeTab,
    mainOpen,
    setActiveTab,
    systemTabs: [...leadingSystemTabs, ...systemTabs],
    layoutTabs,
    expandedTools,
    automationTabParsed,
    tabs,
  };
}
