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
import { Globe01, Monitor01 } from "@untitledui/icons";
import { createElement } from "react";
import {
  COMMERCE_DISCOVERY_ICON,
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  getDevConnectionId,
  useConnections,
  useMCPClientOptional,
  useMCPToolsListQuery,
  useProjectContext,
  useVirtualMCP,
  WellKnownOrgMCPId,
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
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { hasEditableDecoContent } from "@/components/sections-editor/page-list";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import type { ThreadExpandedTool } from "@decocms/shared/entities";
import { FileTypeIcon } from "@/components/file-type-icon";
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
import { useTaskMetadata } from "./use-task-metadata";
import { resolvePreviewSource } from "./preview-source";
import {
  getSourceSystemTabs,
  shouldDeepLinkSourceTab,
} from "./source-system-tabs";
import { useCapability } from "@/hooks/use-capability";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { useNavV2, useReportsOnly } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

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
  /**
   * The tab id of the configured default main view, when it is a landing view
   * that should lead the bar (Overview / Preview / Content / a pinned view).
   * `null` when the default is a trailing/anchored tab (Settings, Automations,
   * git) or Chat — those keep their position rather than being promoted.
   */
  leadTabId: string | null;
}

export function useMainPanelTabs(ctx: {
  virtualMcpId: string;
  taskId: string;
}): MainPanelTabs {
  const t = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    main?: string | 0;
  };
  const entity = useVirtualMCP(ctx.virtualMcpId);
  const metadata = useTaskMetadata(ctx.taskId);
  const { org } = useProjectContext();
  const { currentBranch, activeTask } = useChatTask();

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
  const navV2 = useNavV2();
  const connections = useConnections({ includeVirtual: true });

  // Show "Content" only when decofile/meta confirm editable pages or sections
  // — same rule as Preview's Sections editor toggle. Fetch only after the dev
  // server is up (shared query keys with Preview / Content). Requires
  // SandboxEventsProvider (desktop tabs bar lives inside VmEventsBridge).
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
  // Subscribe to the same query keys as Preview. The committed `.deco/*.gen.json`
  // snapshots are read as soon as the daemon is up (before the dev server), so
  // the Content tab can show without waiting; the live route fetch stays gated
  // behind `devServerReady` and takes over once the preview warms up.
  const { data: decofile } = useDecofile(decofileFetchParams, {
    fetchEnabled: devServerReady,
  });
  const { data: meta } = useLiveMeta(decofileFetchParams, {
    fetchEnabled: devServerReady,
  });
  const showContentTab = hasEditableDecoContent(decofile, meta);

  /**
   * Assets is a per-site tab: it shows whenever an S3 bucket is associated to
   * this project's site slug (managed `deco-assets-<slug>` or a BYOB bucket).
   * Resolved through `resolveAgentSiteSlug` so renaming the project doesn't
   * move its tenancy. Uses the non-suspense configs query so the bar never
   * blocks on the bucket list.
   */
  const siteSlug = resolveAgentSiteSlug(entity);
  const fileConfigsQuery = useFileConfigsQuery();
  const showAssetsTab = !!matchSiteSlugConfig(
    fileConfigsQuery.data?.configs ?? [],
    siteSlug,
  );
  // Don't bounce a deep-linked `?main=assets` away before the first config load resolves.
  const assetsTabPending = fileConfigsQuery.isPending;

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
        : rawActiveTab === "assets" && !showAssetsTab && !assetsTabPending
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
  //
  // Overview (the Super Agent's home board) is agent-independent — it renders
  // in place on any shell (see MainPanelContent's `overview` branch). Reports-
  // only orgs pin it as the first tab on EVERY agent, so the top bar stays a
  // stable Overview · Preview · Code · Report set regardless of which agent the
  // thread happens to be on. Clicking it never switches agents.
  // Under the first-class navigation Overview is the sidebar's "Home".
  if (
    (effectiveDefaultMainView?.type === "overview" || reportsOnly) &&
    !navV2
  ) {
    leadingSystemTabs.push({
      id: "overview",
      title: t("common.mainPanelTabs.overview"),
    });
  }
  // Reports-only orgs get a persistent Preview/Code entry point to their
  // storefront regardless of which agent/screen they're on — visibility is
  // keyed to the settled org flag, not to whether the current agent happens to
  // have a mirrored `githubRepo`. Clicking from off the Report Agent deep-links
  // into it (see setActiveTab).
  leadingSystemTabs.push(
    ...getSourceSystemTabs(previewSource === "repo" || reportsOnly).map(
      (tab) => ({
        id: tab.id,
        title:
          tab.id === "preview"
            ? t("common.mainPanelTabs.preview")
            : tab.id === "code"
              ? t("common.mainPanelTabs.code")
              : tab.title,
      }),
    ),
  );

  const systemTabs: Array<{ id: string; title: string }> = [];
  // A tab configured as the default main view stays pinned in the bar even
  // before its runtime data is ready (e.g. Content while the repo is still
  // cloning) — otherwise the bar would drop the tab the user chose to land on.
  const contentIsDefaultMain = effectiveDefaultMainView?.type === "content";
  if (hasClonableSource && (showContentTab || contentIsDefaultMain)) {
    systemTabs.push({
      id: "content",
      title: t("common.mainPanelTabs.content"),
    });
  }
  if (showAssetsTab) {
    systemTabs.push({
      id: "assets",
      title: t("common.mainPanelTabs.assets"),
    });
  }
  if (gitTabVisible) {
    systemTabs.push({
      id: "git",
      title: t("common.mainPanelTabs.reviewChanges"),
    });
  }
  /** Reports-only orgs and the first-class navigation both get a curated top
   *  bar: no Automations, no Settings — both live in the Settings section. */
  if (!reportsOnly && !navV2) {
    systemTabs.push({
      id: "automations",
      title: t("common.mainPanelTabs.automations"),
    });
    if (canManageAgents) {
      systemTabs.push({
        id: "settings",
        title: t("common.mainPanelTabs.settings"),
      });
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

  // Reports-only orgs surface the Report app on EVERY agent, not just the
  // Report Agent. It renders in place from the Commerce Discovery connection —
  // AppViewContent fetches that connection directly, so no aggregation into the
  // current agent (and no agent switch) is needed. On the Report Agent itself
  // the loop above already added it with its configured label/icon, so this is
  // a no-op there (dedup by tab id).
  // Under the first-class navigation the Report is a sidebar destination.
  if (reportsOnly && !navV2) {
    const reportConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);
    const reportTabId = formatPinnedViewTabId(
      reportConnectionId,
      COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
    );
    if (!pinnedTabMap.has(reportTabId)) {
      pinnedTabMap.set(reportTabId, {
        id: reportTabId,
        title: t("common.mainPanelTabs.report"),
        appId: reportConnectionId,
        iconKey: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
        iconUrl: COMMERCE_DISCOVERY_ICON,
      });
    }
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

  const onReportAgent =
    ctx.virtualMcpId === getCommerceDiscoveryAgentId(org.id);

  // The default main view leads the tab bar (see selectBarSlots) — but only
  // when it's a genuine landing view. The anchored trailing tabs (Settings,
  // Automations, git) and Chat keep their position rather than jumping to the
  // front, so they're not promoted.
  const rawDefaultTabId = resolveDefaultTabId(layoutForDefault);
  const leadTabId =
    rawDefaultTabId === "settings" ||
    rawDefaultTabId === "automations" ||
    rawDefaultTabId === "git"
      ? null
      : rawDefaultTabId;

  const setActiveTab = (id: string) => {
    // On a reports-only org sitting on any shell other than the Report Agent
    // (e.g. the Super Agent home), the storefront preview lives on the Report
    // Agent — so deep-link into it with the panel open instead of trying to
    // preview the current agent, which has no source. On the Report Agent
    // itself this falls through to the normal tab-toggle below.
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: id })) {
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId: crypto.randomUUID() },
        search: { virtualmcpid: getCommerceDiscoveryAgentId(org.id), main: id },
      });
      return;
    }
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
    leadTabId,
  };
}
