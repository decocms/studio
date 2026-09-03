/** A project's DURABLE views, continuing the org-wide rows above them as one
 *  list. Renders ONLY in project context, off the resolved scope: an org has no
 *  Site Editor, and a fallback would put one project's rows under
 *  a header saying you are looking at the organization. The main panel's tab bar
 *  keeps the ephemeral per-thread views (an open file, a deck, a tool result),
 *  which mean nothing outside the thread that made them. Gating is COARSE on
 *  purpose — the sidebar sits above the agent shell and cannot see the sandbox,
 *  so rows gate on what a project row can know (a repo, a bucket) and each panel
 *  explains the rest in its own empty state. Review changes is absent by choice:
 *  its panel resolves only against an open PR, so the row would land on the
 *  preview more often than not, and it stays in the tab bar where its own gate
 *  governs it. */

import type { ReactNode } from "react";
import { Grid01, Image01, Lightning01, Monitor01 } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
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
  const fileConfigs = useFileConfigsQuery();
  const navigateToAgent = useNavigateToAgent();
  const leafPath = useLeafRoutePath();
  const activeTabId = useActivePanelTabId();

  if (!project) return null;

  const hasRepo = agentHasClonableSource(project.metadata);
  const hasAssets = !!matchSiteSlugConfig(
    fileConfigs.data?.configs ?? [],
    resolveAgentSiteSlug(project),
  );

  const views: ProjectView[] = [];
  if (hasRepo) {
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
  if (hasAssets) {
    views.push({
      key: "assets",
      label: t("common.mainPanelTabs.assets"),
      icon: <Image01 size={16} />,
      panel: "assets",
      isActive: (tabId) => tabId === "assets",
    });
  }

  /**
   * The project's pinned app views — the one pin mechanism with a real writer
   * (Settings › Layout). Same two filters the tab bar applies: a pin whose
   * connection is no longer aggregated has no toggle to turn it off, and
   * `fetch_assets` is a retired admin view that the native Assets row replaced.
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
