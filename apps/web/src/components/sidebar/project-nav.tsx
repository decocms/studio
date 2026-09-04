/** A project's durable views, continuing the org-wide rows above them as one
 *  list. Renders only in project context: an organization has no Site Editor,
 *  and falling back would put one project's rows under an organization header.
 *  Configurable rows share their presence gates with Layout and additionally
 *  require the project's sidebar selection. The main panel bar keeps
 *  contextual and per-thread views, such as Review changes or an open file,
 *  which do not belong in durable navigation. */

import type { ReactNode } from "react";
import { type LinkProps, useParams } from "@tanstack/react-router";
import {
  BarChartSquare02,
  CheckDone01,
  Columns03,
  Globe02,
  Grid01,
  Home02,
  Image01,
  Lightning01,
  Monitor01,
  Server01,
} from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useProjectScope } from "@/hooks/use-project-scope";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { keepAttachedPinnedViews } from "@/layouts/main-panel-tabs/attached-pinned-views";
import {
  formatPinnedViewTabId,
  parseAutomationTabId,
} from "@/layouts/main-panel-tabs/tab-id";
import { isSurfaceTab } from "@/layouts/main-panel-tabs/source-system-tabs";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectNativeViewPresence } from "@/layouts/main-panel-tabs/use-project-native-view-presence";
import {
  PROJECT_NATIVE_VIEW_IDS,
  projectSidebarViewPresence,
  resolveProjectSidebarViews,
  selectedProjectSidebarViews,
  type ProjectNativeViewId,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import { useOptimisticProjectSidebarViews } from "@/layouts/main-panel-tabs/optimistic-project-sidebar-views";
import { resolvePanelNavigationSearch } from "@/layouts/main-panel-tabs/panel-navigation-search";

/** A project's curated app views. The metadata bag is `.loose()`, so this
 *  validates the shape rather than trusting it. */
function pinnedViewsOf(project: VirtualMCPEntity): PinnedView[] {
  const ui = (
    project.metadata as { ui?: { pinnedViews?: unknown } } | undefined
  )?.ui;
  if (!Array.isArray(ui?.pinnedViews)) return [];
  return ui.pinnedViews.filter(
    (pv): pv is PinnedView =>
      !!pv &&
      typeof pv === "object" &&
      typeof (pv as PinnedView).connectionId === "string" &&
      typeof (pv as PinnedView).toolName === "string",
  );
}

interface PinnedView {
  connectionId: string;
  toolName: string;
  label?: string;
  icon?: string | null;
}

interface ProjectView {
  key: string;
  label: string;
  icon: ReactNode;
  link: LinkProps;
  /** Tab ids this row owns, reconstructed from the matched route and its typed
   * params by `useActivePanelTabId`. */
  isActive: (tabId: string | undefined) => boolean;
  /** `data-tour` anchor, for the one row a product tour highlights. */
  dataTour?: string;
}

export function ProjectNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { project, scopeId } = useProjectScope();
  const params = useParams({ strict: false });
  const activeTabId = useActivePanelTabId();
  const nativeViews = useProjectNativeViewPresence(project);
  const optimisticSidebarViews = useOptimisticProjectSidebarViews(scopeId);

  if (!scopeId) return null;
  const projectParams = { org: params.org ?? "", agentId: scopeId };
  const projectSearch = (previous: Record<string, unknown>) =>
    resolvePanelNavigationSearch({
      previous,
      destination: "agent",
    });

  const hasClonableSource = project
    ? agentHasClonableSource(project.metadata)
    : false;
  const sidebarViews = project
    ? (optimisticSidebarViews ?? resolveProjectSidebarViews(project.metadata))
    : [];
  /** The URL is enough to paint the structural destinations immediately.
   * Optional rows wait for the entity: treating an unresolved project as
   * unversioned would flash compatibility defaults before an explicit saved
   * layout loaded. */
  const selectedViews = new Set(
    project
      ? selectedProjectSidebarViews(
          sidebarViews,
          projectSidebarViewPresence(hasClonableSource, nativeViews.presence),
          optimisticSidebarViews !== undefined
            ? 1
            : project.metadata.sidebarViewsVersion,
        )
      : [],
  );

  /** Home, Reports, and Tasks are the structural project spine, not
   * configurable app views. They stay first even while the non-blocking project
   * query is resolving. */
  const views: ProjectView[] = [
    {
      key: "overview",
      label: t("sidebar.navDestinations.home"),
      icon: <Home02 size={16} />,
      link: {
        to: PROJECT_ROUTE.root,
        params: projectParams,
        search: projectSearch,
      },
      isActive: (tabId) => tabId === "overview",
    },
    {
      key: "reports",
      label: t("sidebar.navDestinations.reports"),
      icon: <BarChartSquare02 size={16} />,
      link: {
        to: PROJECT_ROUTE.reports,
        params: projectParams,
        search: projectSearch,
      },
      isActive: (tabId) => tabId === "reports",
    },
    {
      key: "board",
      label: t("sidebar.navDestinations.tasks"),
      icon: <Columns03 size={16} />,
      link: {
        to: PROJECT_ROUTE.tasks,
        params: {
          org: params.org ?? "",
          agentId: scopeId,
          taskKey: undefined,
        },
        search: projectSearch,
      },
      isActive: (tabId) => tabId === "board",
      dataTour: LAYOUT_TOUR_ANCHORS.tasks,
    },
  ];
  if (selectedViews.has("site-editor")) {
    /** One row for one surface. Preview, Content and Code are the same place
     *  seen three ways, so they are tabs on it rather than sibling rows, and
     *  the row stays runtime-agnostic: it lands on whatever session the project
     *  already has instead of pinning a mode the thread cannot change later. */
    views.push({
      key: "site-editor",
      label: t("sidebar.projectNav.siteEditor"),
      icon: <Monitor01 size={16} />,
      link: {
        to: PROJECT_ROUTE.siteEditor,
        params: projectParams,
        search: projectSearch,
      },
      /** Preview, Content and Code are three views of this one surface, so the
       *  row stays lit across all of them. */
      isActive: (tabId) => !!tabId && isSurfaceTab(tabId),
      dataTour: LAYOUT_TOUR_ANCHORS.siteEditor,
    });
  }
  const nativeViewRows: Record<
    ProjectNativeViewId,
    Pick<ProjectView, "label" | "icon">
  > = {
    assets: {
      label: t("common.mainPanelTabs.assets"),
      icon: <Image01 size={16} />,
    },
    hosting: {
      label: t("common.mainPanelTabs.hosting"),
      icon: <Server01 size={16} />,
    },
    e2e: {
      label: t("common.mainPanelTabs.e2e"),
      icon: <CheckDone01 size={16} />,
    },
    analytics: {
      label: t("common.mainPanelTabs.analytics"),
      icon: <BarChartSquare02 size={16} />,
    },
    cdn: {
      label: t("common.mainPanelTabs.cdn"),
      icon: <Globe02 size={16} />,
    },
  };
  for (const viewId of PROJECT_NATIVE_VIEW_IDS) {
    if (!selectedViews.has(viewId)) continue;
    const row = nativeViewRows[viewId];
    views.push({
      key: viewId,
      label: row.label,
      icon: row.icon,
      link: {
        to: viewId === "cdn" ? PROJECT_ROUTE.monitor : PROJECT_ROUTE[viewId],
        params: projectParams,
        search: projectSearch,
      },
      isActive: (tabId) => tabId === viewId,
    });
  }

  /**
   * The project's pinned app views — the one pin mechanism with a real writer
   * (Settings › Layout). A pin whose connection is no longer aggregated has no
   * toggle to turn it off, and `fetch_assets` is a retired admin view that the
   * native Assets row replaced, so neither becomes a stale navigation row.
   *
   * The tab id carries its own payload (`app:<connection>:<tool>`), which the
   * canonical tab-route mapper expands into typed path params.
   */
  for (const pinned of keepAttachedPinnedViews(
    project ? pinnedViewsOf(project) : [],
    (project?.connections ?? []).map((c) => c.connection_id),
  )) {
    if (pinned.toolName === "fetch_assets") continue;
    views.push({
      key: `pinned:${pinned.connectionId}:${pinned.toolName}`,
      label: pinned.label || pinned.toolName,
      icon: pinned.icon ? (
        <img src={pinned.icon} alt="" className="size-4 rounded-[3px]" />
      ) : (
        <Grid01 size={16} />
      ),
      link: {
        to: PROJECT_ROUTE.app,
        params: {
          ...projectParams,
          connectionId: pinned.connectionId,
          toolName: pinned.toolName,
        },
        search: projectSearch,
      },
      isActive: (tabId) =>
        tabId === formatPinnedViewTabId(pinned.connectionId, pinned.toolName),
    });
  }
  if (selectedViews.has("automations")) {
    views.push({
      key: "automations",
      label: t("sidebar.projectNav.automations"),
      icon: <Lightning01 size={16} />,
      link: {
        to: PROJECT_ROUTE.automations,
        params: projectParams,
        search: projectSearch,
      },
      /** The list and one automation's detail (`automation:<id>`) are the same
       *  row. */
      isActive: (tabId) =>
        tabId === "automations" || parseAutomationTabId(tabId) !== null,
      dataTour: LAYOUT_TOUR_ANCHORS.automations,
    });
  }

  const onProject = params.agentId === scopeId;

  return (
    <SidebarMenu className="gap-1">
      {views.map((view) => (
        <SidebarNavRow
          key={view.key}
          icon={view.icon}
          label={view.label}
          dataTour={view.dataTour}
          isActive={onProject && view.isActive(activeTabId)}
          link={view.link}
          /** Project Home remains a real link; every row uses the same
           * canonical project-search policy so the mounted session keeps its
           * active chat. */
          onSelect={() => {
            track("project_nav_clicked", { surface: view.key });
            onNavigate?.();
          }}
        />
      ))}
    </SidebarMenu>
  );
}
