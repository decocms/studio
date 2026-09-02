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

import { useQuery } from "@tanstack/react-query";
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
  parseAutomationTabId,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  resolveActiveTabAndOpen,
  resolveDefaultTabId,
  resolveTabClickTarget,
  type AutomationTabParsed,
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
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { resolveCmsMode, type CmsMode } from "@decocms/shared/sdk/types";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import {
  useControlPlaneViews,
  useReportsOnly,
} from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { KEYS } from "@/lib/query-keys";
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
  /** The open thread, or `null` on a destination route that names none. */
  taskId: string | null;
}): MainPanelTabs {
  const t = useT();
  const { openPanel, closePanel } = usePanelNavigate();
  const search = useSearch({ strict: false }) as { mainpanel?: boolean };
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
            cms?: CmsMode | null;
            cmsDefaultOpen?: boolean | null;
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
  const reportsOnly = useReportsOnly();
  // Per-view product gate for the control-plane tabs (Hosting · E2E · Deco
  // Analytics) while the surface rolls out: local dev / deco.cx staff / GA turn
  // all three on; otherwise each view follows its own org flag. Layered ON TOP
  // of the deployment/ownership gates below — not a replacement for them.
  const controlPlaneViews = useControlPlaneViews();
  // Per-site Hosting tab: only surfaces when the deployment wired the
  // control-plane BFF proxy (public config `hostingEnabled`).
  const hostingEnabled = usePublicConfig().hostingEnabled === true;
  // Warehouse-wired prerequisite for the CDN Monitor tab (public config
  // `monitorEnabled` = stats-lake ClickHouse creds set), independent of the
  // control-plane. The product gate (deco.cx staff / MONITOR_GA / the org's
  // `monitor_enabled` flag) is layered on top at the tab push via
  // `controlPlaneViews.monitor`; ownership is enforced by `hostingOwned`.
  // Local dev opens the tab even without warehouse creds so the shell can be
  // validated; it then renders its own "warehouse not wired" state.
  const monitorEnabled =
    usePublicConfig().monitorEnabled === true ||
    usePublicConfig().auth.localMode === true;
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

  /**
   * Assets is a per-site tab: it shows whenever an S3 bucket is associated to
   * this project's site slug (managed `deco-assets-<slug>` or a BYOB bucket).
   * Resolved through `resolveAgentSiteSlug` so renaming the project doesn't
   * move its tenancy. Uses the non-suspense configs query so the bar never
   * blocks on the bucket list.
   */
  const siteSlug = resolveAgentSiteSlug(entity);
  // Per-site ownership gate for the control-plane tabs (Hosting / E2E /
  // Analytics). `hostingEnabled` only says the DEPLOYMENT wired the BFF; it does
  // NOT say this org owns THIS site. Without the ownership probe the three tabs
  // render for every site and then fail with 404 "Site not found in
  // organization" (the BFF's own isolation guard). Probe the local access
  // endpoint (no control-plane call) and only surface the tabs when the org owns
  // the resolved slug. Undefined while loading → tabs stay hidden until settled,
  // so an unowned site never flashes the tabs then drops them.
  const hostingAccessQuery = useQuery({
    queryKey: KEYS.hostingAccess(org.slug, siteSlug ?? ""),
    queryFn: async () => {
      const res = await fetch(
        `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug ?? "")}/access`,
      );
      if (!res.ok) return { owned: false, canWrite: false };
      return (await res.json()) as { owned: boolean; canWrite: boolean };
    },
    // The /access probe reads only `org_sites` (no control-plane), so it also
    // gates the native CDN Monitor tab — fire it whenever EITHER the
    // control-plane tabs or the CDN tab could surface.
    enabled: (hostingEnabled || monitorEnabled) && !!siteSlug,
    staleTime: 60_000,
  });
  const hostingOwned = hostingAccessQuery.data?.owned === true;
  const fileConfigsQuery = useFileConfigsQuery();
  const showAssetsTab = !!matchSiteSlugConfig(
    fileConfigsQuery.data?.configs ?? [],
    siteSlug,
  );
  // Don't bounce a deep-linked Assets view away before the first config load resolves.
  const assetsTabPending = fileConfigsQuery.isPending;

  // Per-view visibility for the control-plane (Hosting/E2E/Analytics) and
  // Monitor tabs — the single source of truth for both the tab push below AND
  // the deep-link normalization further down, so a `?main=hosting` URL can't
  // mount a tab whose button is hidden. `hostingOwned` is false while the
  // `/access` probe is in flight, so a deep-linked control-plane tab is kept
  // until ownership settles (`hostingAccessPending`) rather than bounced early.
  const hostingAccessPending = hostingAccessQuery.isPending;
  const showHostingTab =
    hostingEnabled && hostingOwned && controlPlaneViews.hosting;
  const showE2eTab = hostingEnabled && hostingOwned && controlPlaneViews.e2e;
  const showAnalyticsTab =
    hostingEnabled && hostingOwned && controlPlaneViews.analytics;
  const showCdnTab =
    monitorEnabled && hostingOwned && controlPlaneViews.monitor;

  const { activeTab: rawActiveTab, mainOpen: rawMainOpen } =
    resolveActiveTabAndOpen({
      panelTabId,
      mainPanelParam: search.mainpanel,
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
  // The agent's configured default main view — but never a hidden gated view.
  // An agent whose default is a hosting/e2e/analytics/cdn the current user can't
  // see would otherwise make every fallback below resolve to that same hidden
  // id; drop to the base default ("settings", never gated) in that case.
  //
  // Gate on the default view's TYPE (the NATIVE control-plane view), not on the
  // resolved id: an agent-declared ext-app whose id merely collides with
  // "analytics"/"hosting"/etc. is not the native gated view and must still open.
  // And, like `controlPlaneTabHidden` below, only drop once ownership is known
  // (`!hostingAccessPending`) — `hostingOwned` is false while the probe is in
  // flight, so without this guard the default (and `leadTabId`) would flip from
  // "settings" back to the gated tab after load, reordering the bar.
  const configuredDefaultTabId = resolveDefaultTabId(layoutForDefault);
  const defaultViewType = effectiveDefaultMainView?.type;
  const defaultTabHidden =
    !hostingAccessPending &&
    ((defaultViewType === "hosting" && !showHostingTab) ||
      (defaultViewType === "e2e" && !showE2eTab) ||
      (defaultViewType === "analytics" && !showAnalyticsTab) ||
      (defaultViewType === "cdn" && !showCdnTab));
  const visibleDefaultTabId = defaultTabHidden
    ? resolveDefaultTabId(null)
    : configuredDefaultTabId;
  // A deep-linked control-plane / Monitor tab whose button is hidden (no BFF, no
  // ownership, or the org isn't flagged in) falls back to the default view once
  // ownership is known — mirroring git/content/assets — so a stale URL never
  // mounts a tab that only 503/404s.
  const controlPlaneTabHidden =
    !hostingAccessPending &&
    ((rawActiveTab === "hosting" && !showHostingTab) ||
      (rawActiveTab === "e2e" && !showE2eTab) ||
      (rawActiveTab === "analytics" && !showAnalyticsTab) ||
      (rawActiveTab === "cdn" && !showCdnTab));
  /** Resolved BEFORE the active tab, because what the surface offers is now the
   *  whole answer to whether a named view survives (see setActiveTab). */
  const surfaceTabIds = resolveSurfaceTabs({
    hasSource: previewSource === "repo" || reportsOnly,
    runtime,
    cmsMode,
  });
  const showContent = surfaceTabIds.includes("content");
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
  /** The surface's own landing view is the preview, for every runtime — a URL
   *  that names no view lands there, and `?main=content` is the only thing that
   *  opens Content. What a CMS session gets on that preview is the blocks editor
   *  already open (see `defaultPreviewEditingMode`), a mode of the view rather
   *  than a second address, so nothing here has to second-guess the URL. */
  const activeTab =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? visibleDefaultTabId
      : rawActiveTab === "content" && !showContent
        ? visibleDefaultTabId
        : rawActiveTab === "assets" && !showAssetsTab && !assetsTabPending
          ? visibleDefaultTabId
          : codeTabHidden
            ? visibleDefaultTabId
            : controlPlaneTabHidden
              ? visibleDefaultTabId
              : rawActiveTab;
  const mainOpen =
    rawActiveTab === "git" && !gitTabVisible && !prQuery.isPending
      ? false
      : rawMainOpen;

  const automationTabParsed = parseAutomationTabId(activeTab);

  const surfaceTabTitle = (id: SurfaceTabId) =>
    id === "site-editor"
      ? t("common.mainPanelTabs.preview")
      : id === "content"
        ? t("common.mainPanelTabs.content")
        : t("common.mainPanelTabs.code");
  const leadingSystemTabs: Array<{ id: string; title: string }> =
    surfaceTabIds.map((id) => ({ id, title: surfaceTabTitle(id) }));

  const systemTabs: Array<{ id: string; title: string }> = [];
  if (showAssetsTab) {
    systemTabs.push({
      id: "assets",
      title: t("common.mainPanelTabs.assets"),
    });
  }
  // Hosting, E2E, and Deco Analytics are peers over the same control-plane
  // connection, ordered Hosting · E2E · Deco Analytics — but each is gated by
  // its own org flag (see useControlPlaneViews), so a client can get one without
  // the others. All still require org ownership of the resolved site
  // (`hostingOwned`), not just the deployment-wide `hostingEnabled`, so a site
  // the org doesn't own never surfaces them (matching the BFF's per-site
  // isolation guard).
  if (showHostingTab) {
    systemTabs.push({
      id: "hosting",
      title: t("common.mainPanelTabs.hosting"),
    });
  }
  if (showE2eTab) {
    systemTabs.push({
      id: "e2e",
      title: t("common.mainPanelTabs.e2e"),
    });
  }
  if (showAnalyticsTab) {
    systemTabs.push({
      id: "analytics",
      title: t("common.mainPanelTabs.analytics"),
    });
  }
  // Native CDN Monitor tab — the first-class replacement for the old admin
  // "Monitor" iframe. Gated on the warehouse being wired (`monitorEnabled`), org
  // ownership of the site (`hostingOwned`), AND the per-view product gate
  // (`controlPlaneViews.monitor`: local dev / deco.cx staff / MONITOR_GA / the
  // org's `monitor_enabled` flag) so a client never sees it until deco.cx opts
  // that org in. Independent of `hostingEnabled`: it reads the stats-lake
  // warehouse directly, not the control-plane, so a deployment can offer CDN
  // without hosting.
  if (showCdnTab) {
    systemTabs.push({
      id: "cdn",
      title: t("common.mainPanelTabs.cdn"),
    });
  }
  if (gitTabVisible) {
    systemTabs.push({
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

  /** The bar carries the surface's own views, then the gated system views, then
   *  the EPHEMERAL per-thread tabs — an open file, a deck, a library preview, an
   *  app view, an expanded tool.
   *
   *  `systemTabs` is spread here and not left to the sidebar: the sidebar
   *  re-homed Site Editor, Assets, pinned views and Automations, and NOTHING
   *  else. Review changes (`git`), Hosting, E2E, Deco Analytics and CDN have no
   *  row there and nothing in the app navigates to those panels, so dropping
   *  them from the bar left them reachable only by hand-typing the URL. A view
   *  appearing in both places is fine — Site Editor already does. */
  const allTabs: Tab[] = [
    ...surfaceTabs,
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
  ];

  /** One button per id, first occurrence wins. An agent-declared tab is free to
   *  reuse a native id ("assets", "hosting", …); without this the list carries
   *  it twice — duplicate React keys in the bar and in the mobile select — and
   *  the panel renders the native view anyway, so the native tab is the one to
   *  keep. */
  const seenTabIds = new Set<string>();
  const tabs: Tab[] = allTabs.filter((tab) => {
    if (seenTabIds.has(tab.id)) return false;
    seenTabIds.add(tab.id);
    return true;
  });

  const onReportAgent =
    ctx.virtualMcpId === getCommerceDiscoveryAgentId(org.id);

  // The default main view leads the tab bar (see selectBarSlots) — but only
  // when it's a genuine landing view. The anchored trailing tabs (Settings,
  // Automations, git) and Chat keep their position rather than jumping to the
  // front, so they're not promoted. Uses the visibility-filtered default so a
  // hidden gated view never leads the bar.
  const leadTabId =
    visibleDefaultTabId === "settings" ||
    visibleDefaultTabId === "automations" ||
    visibleDefaultTabId === "git"
      ? null
      : visibleDefaultTabId;

  const setActiveTab = (id: string) => {
    // On a reports-only org sitting on any shell other than the Report Agent
    // (e.g. the Super Agent home), the storefront preview lives on the Report
    // Agent — so deep-link into it with the panel open instead of trying to
    // preview the current agent, which has no source. On the Report Agent
    // itself this falls through to the normal tab-toggle below.
    if (shouldDeepLinkSourceTab({ reportsOnly, onReportAgent, tabId: id })) {
      openPanel(id, {
        virtualmcpid: getCommerceDiscoveryAgentId(org.id),
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
