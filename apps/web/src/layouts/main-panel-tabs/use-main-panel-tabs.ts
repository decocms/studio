/**
 * State assembly for the main-panel tab system.
 *
 * Assembles all tab sources (system + agent-declared + task-expanded +
 * ephemeral automation), resolves the active tab from the URL, and
 * returns a click-aware `setActiveTab` that implements tab-as-toggle
 * semantics via `resolveTabClickTarget`.
 *
 * MainPanelTabsProvider evaluates this once per mounted task workspace. The
 * desktop bar, mobile selector, and guarded route bodies consume that shared
 * result through context.
 */

import { useSearch } from "@tanstack/react-router";
import { useRouteDefaultMain } from "@/hooks/use-route-default-main";
import { Globe01, Monitor01 } from "@untitledui/icons";
import { createElement } from "react";
import {
  getCommerceDiscoveryAgentId,
  getDevConnectionId,
  useConnections,
  useMCPClientOptional,
  useMCPToolsListQuery,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/lib/agent-capabilities";
import { useChatTask } from "@/components/chat/index";
import { getActiveGithubRepo } from "@/lib/github-repo.ts";
import { usePrByBranch } from "@/components/thread/github/use-pr-data.ts";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import type { ThreadExpandedTool } from "@decocms/shared/entities";
import { FileTypeIcon } from "@/components/file-type-icon";
import {
  formatPinnedViewTabId,
  formatAgentViewTabId,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  resolveActiveTabAndOpen,
  resolveDefaultTabId,
  resolveTabClickTarget,
} from "./tab-id";
import { useActivePanelTabId, usePanelNavigate } from "./use-panel-navigate";
import { resolveTabIcon, type TabIcon, type TabKind } from "./resolve-tab-icon";
import { useTaskMetadata } from "./use-task-metadata";
import { resolvePreviewSource } from "./preview-source";
import {
  isSurfaceTab,
  resolveSurfaceTabs,
  shouldDeepLinkSourceTab,
  type SurfaceTabId,
} from "./source-system-tabs";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { resolveCmsMode } from "@decocms/shared/sdk/types";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { useProjectNativeViewPresence } from "./use-project-native-view-presence";
import {
  projectActiveViewUnavailable,
  projectDefaultViewUnavailable,
  projectMainViewPresence,
  resolveProjectMainViewContext,
} from "./project-sidebar-views";
import { resolveActiveRouteTitle } from "./active-route-title";

type AgentTabDef = {
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
  virtualMcpId: string;
  activeTab: string;
  /** Dynamic title that remains available when mobile Chat unmounts Main. */
  activeRouteTitle?: string;
  mainOpen: boolean;
  setActiveTab: (id: string) => void;
  tabs: Tab[];
}

export function useMainPanelTabsState(ctx: {
  virtualMcpId: string;
  /** The open thread, or `null` on a destination route that names none. */
  taskId: string | null;
}): MainPanelTabs {
  const t = useT();
  const { openPanel, closePanel } = usePanelNavigate();
  const routeSearch = useSearch({ strict: false });
  const mainPanelParam =
    "mainpanel" in routeSearch && typeof routeSearch.mainpanel === "boolean"
      ? routeSearch.mainpanel
      : undefined;
  const panelTabId = useActivePanelTabId();
  const routeDefaultMain = useRouteDefaultMain();
  const entity = useVirtualMCP(ctx.virtualMcpId);
  const metadata = useTaskMetadata(ctx.taskId);
  const { org } = useProjectContext();
  const { currentBranch, activeTask } = useChatTask();
  const isDesktopApp = useIsDesktopApp();

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

  const entityLayout = entity?.metadata.ui?.layout ?? null;
  const layoutTabs: AgentTabDef[] = entityLayout?.tabs ?? [];

  // The ephemeral dev connection (`dev_<id>`) the agent's sandbox dev server is
  // served through. Its views are auto-detected from the dev server's own MCP
  // app below — no pairing / live-partner config involved.
  const devConnId = entity?.id ? getDevConnectionId(entity.id) : null;
  const expandedTools: ThreadExpandedTool[] = metadata?.expanded_tools ?? [];
  const hasActiveGithubRepo = agentHasConnectedGithub(entity);
  const reportsOnly = useReportsOnly();
  const { scopeId, project: scopedProject } = useProjectScope();
  const mainViewContext = resolveProjectMainViewContext(
    scopeId,
    scopedProject,
    entity,
  );
  const nativeViews = useProjectNativeViewPresence(mainViewContext.project);
  const mainViewPresence = projectMainViewPresence(
    mainViewContext.resolvedScopeId,
    agentHasClonableSource(mainViewContext.project?.metadata),
    nativeViews.presence,
  );
  const connections = useConnections({ includeVirtual: true });

  /** The sandbox dev server's own MCP app supplies the auto-detected dev views
   *  below; needs SandboxEventsProvider, which the desktop tab bar sits inside
   *  via VmEventsBridge. */
  const vmEvents = useSandboxEvents();
  const { vmEntry, previewUrl } = useSandboxLifecycle();
  // What Preview / Code can actually show for THIS thread — see preview-source:
  // a sandbox task run dispatched with no repo (bare `thread:<id>` sandbox key)
  // never checks out the agent's repo, so it gets no Preview / Code tab instead
  // of tabs that render the "connect a GitHub repository" empty state. Every
  // other thread, harness included, still previews the agent repo.
  const previewSource = resolvePreviewSource({
    threadId: ctx.taskId,
    sandboxBranch: activeTask?.branch ?? currentBranch,
    agentHasRepo: agentHasClonableSource(entity?.metadata),
    threadHasRepo:
      agentHasClonableSource(metadata) ||
      agentHasClonableSource(activeTask?.metadata),
  });
  const devServerReady = vmEvents.lifecycle.phase === "running";
  /** THIS session's runtime, off the thread's own stamp — the only authority
   *  (see `@decocms/shared/thread/session-runtime`). It decides one thing here:
   *  Code needs a sandbox working tree, so a CMS session is not offered it. */
  const { runtime, resolved: runtimeResolved } = useSessionRuntime(
    ctx.virtualMcpId,
  );

  // A local-api sandbox serves its dev server on a loopback previewUrl
  // (`http://<handle>.localhost`), which the cloud proxy cannot reach — so the
  // `dev_<id>` route resolves to a connection the pod can't fetch. The browser
  // IS co-located with the daemon, so point the dev MCP client straight at the
  // previewUrl (CORS on the deco dev server is `*`). For agent-sandbox the
  // previewUrl is public, so leave mcpUrl undefined and keep the cloud route.
  const devMcpUrl =
    isDesktopApp && vmEntry && previewUrl
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
  /**
   * Views the BAR still owns. A project's curated pins render as sidebar rows
   * now (see `components/sidebar/project-nav.tsx`), so listing them here too
   * would give one view two homes. A dev connection's auto-discovered views
   * stay: they belong to a running sandbox on this thread, which the sidebar
   * sits above and cannot see.
   */
  const barPinnedViews = firstDevView ? devViews : [];
  const effectiveDefaultMainView =
    firstDevView && devConnId
      ? { type: "ext-apps", id: devConnId, toolName: firstDevView.toolName }
      : (entityLayout?.defaultMainView ?? null);
  /** Content's WHOLE gate: Settings › CMS. `off` takes the view off the surface,
   *  anything else offers it, and nothing session-shaped is consulted — the bar
   *  used to wait on `useDecofile`/`useLiveMeta`, so a tab hung on a read that
   *  lands late or never, and the "pending" escape hatches papering over it
   *  disagreed. "This site has nothing yet" belongs in the view's empty state. */
  const cmsMode = resolveCmsMode(entityLayout);

  // Availability is shared with Layout settings and the project sidebar so a
  // view can never be configurable or navigable where its backing capability
  // is absent. The pending states keep valid deep links stable during discovery.
  const nativeViewPending = {
    assets: nativeViews.assetsPending,
    siteAccess: nativeViews.siteAccessPending,
  };

  const { activeTab: rawActiveTab, mainOpen: rawMainOpen } =
    resolveActiveTabAndOpen({
      panelTabId,
      mainPanelParam,
      routeDefaultMain,
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
  /** Resolve the Site Editor's available subviews before validating a stored
   * default, so a retired Content/Code default cannot fall back to itself when
   * that subview is no longer present. */
  const surfaceTabIds = resolveSurfaceTabs({
    hasSource: previewSource === "repo" || reportsOnly,
    runtime,
    cmsMode,
  });
  const showContent = surfaceTabIds.includes("content");
  // The agent's configured default main view — but never a project view that is
  // absent for this project. Such a default would make every fallback below
  // resolve to the same unreachable id, so use the base default ("settings",
  // never gated) instead.
  //
  // Gate on the default view's TYPE, not an ext-app's id: an agent-declared app
  // whose id merely collides with "analytics"/"hosting"/etc. is not the native
  // gated view and must still open. Preview is a retired spelling of Site
  // Editor; Content and Code are subviews of that same source-backed surface.
  // For resource-backed native views, only drop missing presence once
  // discovery settles.
  const configuredDefaultTabId = resolveDefaultTabId(layoutForDefault);
  const defaultViewType = effectiveDefaultMainView?.type;
  const defaultTabHidden = projectDefaultViewUnavailable(
    defaultViewType,
    mainViewPresence,
    nativeViewPending,
    surfaceTabIds,
    runtimeResolved,
  );
  const visibleDefaultTabId = defaultTabHidden
    ? resolveDefaultTabId(null)
    : configuredDefaultTabId;
  // A deep-linked project view whose backing capability is absent falls back
  // to the default once discovery settles, so stale URLs cannot mount views
  // that would only fail or show another tenant's site.
  const projectViewHidden = projectActiveViewUnavailable(
    rawActiveTab,
    mainViewPresence,
    nativeViewPending,
  );
  /** A bookmarked `code` / `code:<path>` URL on a session the surface offers no
   *  Code view for (a CMS session has no sandbox working tree) would otherwise
   *  keep the URL's tab active with no button for it, mounting CodeTab against
   *  nothing. Fall back like git/content/assets — but only once the runtime is
   *  known (`resolved`), so a coding session whose rows are still loading is
   *  never bounced off its own Code view. */
  const codeTabHidden =
    !surfaceTabIds.includes("code") &&
    runtimeResolved &&
    parseCodeTabId(rawActiveTab) !== null;
  /** The surface's own landing view is Preview for every runtime; Content is
   *  named only by its `/site-editor/content` child. On desktop, Preview
   *  includes Blocks whenever the same product gate exposes Content; it remains
   *  a mode of the view rather than a second address, so nothing here has to
   *  second-guess the URL. */
  const activeTab =
    !panelTabId && !routeDefaultMain && defaultTabHidden
      ? visibleDefaultTabId
      : rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
        ? visibleDefaultTabId
        : rawActiveTab === "content" && !showContent
          ? visibleDefaultTabId
          : codeTabHidden || projectViewHidden
            ? visibleDefaultTabId
            : rawActiveTab;
  const mainOpen =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? false
      : rawMainOpen;

  const surfaceTabTitle = (id: SurfaceTabId) =>
    id === "site-editor"
      ? t("common.mainPanelTabs.preview")
      : id === "content"
        ? t("common.mainPanelTabs.content")
        : t("common.mainPanelTabs.code");
  // Review changes is contextual to the open PR, so it remains in the panel
  // header. The five durable native views are navigated from the sidebar.
  const contextualSystemTabs: Array<{ id: string; title: string }> = [];
  if (gitTabVisible) {
    contextualSystemTabs.push({
      id: "git",
      title: t("common.mainPanelTabs.reviewChanges"),
    });
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
  for (const pv of barPinnedViews) {
    // Retired admin-MCP view, now the native Assets tab: drop stale pins.
    if (pv.toolName === "fetch_assets") continue;
    const id = formatPinnedViewTabId(pv.connectionId, pv.toolName);
    pinnedTabMap.set(id, {
      id,
      title: pv.label || pv.toolName,
      appId: pv.connectionId,
      iconKey: pv.toolName,
      iconUrl: pv.icon ?? null,
    });
  }

  // Ephemeral file-preview tab (the `file` view): surfaces as a pill
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

  // Ephemeral live-HTML preview tab (the `deck` view — decks AND
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

  // Ephemeral Library file-preview tab (the `library-file` view): an org
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

  /** The Site Editor's own switcher, shown only while the panel is on that
   *  surface: the sidebar opens it, these swap the view inside it, so no view
   *  has two homes. Code carries the open file's id so the active button
   *  matches `code:<path>`. */
  const surfaceTabs: Tab[] = isSurfaceTab(activeTab)
    ? surfaceTabIds.map((id) => ({
        id: id === "code" && parseCodeTabId(activeTab) ? activeTab : id,
        title: surfaceTabTitle(id),
        kind: "system" as const,
        icon: resolveTabIcon({ tabId: id, kind: "system", connections }),
      }))
    : [];

  /** The bar carries controls local to the active surface, contextual system
   *  views, agent-declared tabs, and ephemeral per-thread views. Native and
   *  pinned-app project navigation belongs to the sidebar. */
  const allTabs: Tab[] = [
    ...surfaceTabs,
    ...contextualSystemTabs.map((t) => ({
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
      id: formatAgentViewTabId(t.id),
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
  ];

  /** One button per id, first occurrence wins. Agent-declared ids are not
   *  guaranteed unique and may collide with contextual or ephemeral tabs. */
  const seenTabIds = new Set<string>();
  const tabs: Tab[] = allTabs.filter((tab) => {
    if (seenTabIds.has(tab.id)) return false;
    seenTabIds.add(tab.id);
    return true;
  });

  const onReportAgent =
    ctx.virtualMcpId === getCommerceDiscoveryAgentId(org.id);

  const setActiveTab = (id: string) => {
    // On a reports-only org sitting on any shell other than the Report Agent
    // (e.g. the Super Agent home), the storefront preview lives on the Report
    // Agent — so deep-link into it with the panel open instead of trying to
    // preview the current agent, which has no source. On the Report Agent
    // itself this falls through to the normal tab-toggle below.
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: id })) {
      openPanel(id, {
        agentId: getCommerceDiscoveryAgentId(org.id),
        /** Another agent's conversation does not follow the view over. */
        search: (prev) => ({ ...prev, thread: undefined }),
      });
      return;
    }
    const target = resolveTabClickTarget({
      clickedId: id,
      activeTab,
      mainOpen,
    });
    if ("close" in target) closePanel();
    else openPanel(target.tabId);
  };

  return {
    virtualMcpId: ctx.virtualMcpId,
    activeTab,
    activeRouteTitle: resolveActiveRouteTitle({
      activeTab,
      entityTitle: entity?.title,
      pinnedViews: entity?.metadata.ui?.pinnedViews,
    }),
    mainOpen,
    setActiveTab,
    tabs,
  };
}
