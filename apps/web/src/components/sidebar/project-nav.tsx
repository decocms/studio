/** A project's durable views, continuing the org-wide rows above them as one
 *  list. Renders only in project context: an organization has no Site Editor,
 *  and falling back would put one project's rows under an organization header.
 *  Configurable rows share their presence gates with Layout and additionally
 *  require the project's sidebar selection. The main panel bar keeps
 *  contextual and per-thread views, such as Review changes or an open file,
 *  which do not belong in durable navigation. */

import type { ReactNode } from "react";
import {
  BarChartSquare02,
  CheckDone01,
  Globe02,
  Grid01,
  Image01,
  Lightning01,
  Monitor01,
  Server01,
} from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useProjectScope } from "@/hooks/use-project-scope";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { keepAttachedPinnedViews } from "@/layouts/main-panel-tabs/attached-pinned-views";
import {
  formatPinnedViewTabId,
  parseAutomationTabId,
} from "@/layouts/main-panel-tabs/tab-id";
import { isSurfaceTab } from "@/layouts/main-panel-tabs/source-system-tabs";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useLeafRoutePath } from "@/hooks/use-destination-route";
import { useProjectNativeViewPresence } from "@/layouts/main-panel-tabs/use-project-native-view-presence";
import {
  PROJECT_NATIVE_VIEW_IDS,
  projectSidebarViewPresence,
  resolveProjectSidebarViews,
  selectedProjectSidebarViews,
  type ProjectNativeViewId,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import { useOptimisticProjectSidebarViews } from "@/layouts/main-panel-tabs/optimistic-project-sidebar-views";

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
  panel: string;
  /** Tab ids this row owns — the RESOLVED id (`useActivePanelTabId`), not the
   *  raw path segment: a pinned view is `app:<connection>:<tool>` in the URL's
   *  search, and its segment is the bare word `app`, which matches nothing. */
  isActive: (tabId: string | undefined) => boolean;
  /** `data-tour` anchor, for the one row a product tour highlights. */
  dataTour?: string;
}

export function ProjectNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { project } = useProjectScope();
  const navigateToAgent = useNavigateToAgent();
  const leafPath = useLeafRoutePath();
  const activeTabId = useActivePanelTabId();
  const nativeViews = useProjectNativeViewPresence(project);
  const optimisticSidebarViews = useOptimisticProjectSidebarViews(project?.id);

  if (!project) return null;

  const hasClonableSource = agentHasClonableSource(project.metadata);
  const sidebarViews =
    optimisticSidebarViews ?? resolveProjectSidebarViews(project.metadata);
  const selectedViews = new Set(
    selectedProjectSidebarViews(
      sidebarViews,
      projectSidebarViewPresence(hasClonableSource, nativeViews.presence),
      optimisticSidebarViews !== undefined
        ? 1
        : project.metadata.sidebarViewsVersion,
    ),
  );

  const views: ProjectView[] = [];
  if (selectedViews.has("site-editor")) {
    /** One row for one surface. Preview, Content and Code are the same place
     *  seen three ways, so they are tabs on it rather than sibling rows, and
     *  the row stays runtime-agnostic: it lands on whatever session the project
     *  already has instead of pinning a mode the thread cannot change later. */
    views.push({
      key: "site-editor",
      label: t("sidebar.projectNav.siteEditor"),
      icon: <Monitor01 size={16} />,
      panel: "site-editor",
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
      panel: viewId,
      isActive: (tabId) => tabId === viewId,
    });
  }

  /**
   * The project's pinned app views — the one pin mechanism with a real writer
   * (Settings › Layout). A pin whose connection is no longer aggregated has no
   * toggle to turn it off, and `fetch_assets` is a retired admin view that the
   * native Assets row replaced, so neither becomes a stale navigation row.
   *
   * The panel id carries its own payload (`app:<connection>:<tool>`), which
   * `panelLocationForTab` expands into the segment plus its search — so these
   * need no special casing at the navigation call.
   */
  for (const pinned of keepAttachedPinnedViews(
    pinnedViewsOf(project),
    (project.connections ?? []).map((c) => c.connection_id),
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
      panel: formatPinnedViewTabId(pinned.connectionId, pinned.toolName),
      isActive: (tabId) =>
        tabId === formatPinnedViewTabId(pinned.connectionId, pinned.toolName),
    });
  }
  if (selectedViews.has("automations")) {
    views.push({
      key: "automations",
      label: t("sidebar.projectNav.automations"),
      icon: <Lightning01 size={16} />,
      panel: "automations",
      /** The list and one automation's detail (`automation:<id>`) are the same
       *  row. */
      isActive: (tabId) =>
        tabId === "automations" || parseAutomationTabId(tabId) !== null,
      dataTour: LAYOUT_TOUR_ANCHORS.automations,
    });
  }

  const onProject = leafPath === DESTINATION_ROUTE.agents;

  return (
    <SidebarMenu className="gap-1">
      {views.map((view) => (
        <SidebarNavRow
          key={view.key}
          icon={view.icon}
          label={view.label}
          dataTour={view.dataTour}
          isActive={onProject && view.isActive(activeTabId)}
          /** No `link`, so this renders a button: these resolve a SESSION,
           *  reusing an empty thread of the right runtime or minting one. The
           *  destination id is not knowable at render time, so there is no
           *  honest href to put here. The org-wide destinations above stay real
           *  anchors. */
          onSelect={() => {
            track("project_nav_clicked", { surface: view.key });
            navigateToAgent(project.id, { panel: view.panel });
            onNavigate?.();
          }}
        />
      ))}
    </SidebarMenu>
  );
}
