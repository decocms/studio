/** The org-wide destination rows: real `<Link>`s, so nav paints on the first
 *  frame. Projects are a scope, not rows: see `OrgProjectPicker`. Discover has
 *  no row for now; its page stays routable and is still reachable from the
 *  command palette.
 *
 *  The one thing read here is the SCOPED project, to resolve its source and
 *  sidebar preferences. That read is non-blocking and fails open, so the first
 *  frame is unchanged. */

import type { ReactNode } from "react";
import type { LinkProps } from "@tanstack/react-router";
import { BarChartSquare02, Columns03, Folder, Home02 } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { useProjectContext } from "@/sdk";
import { useProjectScope, useScopeId } from "@/hooks/use-project-scope";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import {
  DESTINATION_ROUTE,
  routeExistsInScope,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import {
  effectiveProjectSidebarViews,
  resolveProjectSidebarViews,
  type ProjectSidebarViewsMetadata,
} from "@/layouts/main-panel-tabs/project-sidebar-views";
import { useOptimisticProjectSidebarViews } from "@/layouts/main-panel-tabs/optimistic-project-sidebar-views";
import type { VirtualMcpSidebarView } from "@decocms/shared/sdk/types";

interface NavDestination {
  key: NavDestinationKey;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  /** `nav_destination_clicked`'s `destination` property. PostHog dashboards key
   *  on these exact values, so they are decoupled from the route. */
  trackAs: string;
  link: LinkProps;
  /** `data-tour` anchor, for the rows the layout tour highlights. */
  dataTour?: string;
}

/**
 * `nav_destination_clicked`'s `destination` for the Settings row.
 *
 * Settings left the spine when it became one scope-aware row rendered last
 * (`nav-settings-row.tsx`), but the VALUE did not change: PostHog dashboards
 * key on it, and merging two controls is not a reason to break their series.
 * It stays in this file — the module that owns the analytics vocabulary, and
 * the only one of the two a `bun test` can import without dragging the browser
 * auth client in with it.
 */
export const SETTINGS_DESTINATION = "settings";

/** The destination keys, in display order — and the order the sidebar actually
 *  renders, since `useNavDestinations` maps over this rather than returning a
 *  literal array. Growing or shrinking it is a compile error until the keyed
 *  record below matches, so a test asserting on it pins the real spine. */
export const NAV_DESTINATION_KEYS = [
  "overview",
  "reports",
  "board",
  "files",
] as const;

type NavDestinationKey = (typeof NAV_DESTINATION_KEYS)[number];

/**
 * Whether the scope in force is a project WITHOUT a repo — the state in which
 * Home, Reports and Tasks are dropped, because each is about work on a
 * codebase.
 *
 * Pure so the rule is testable, and it FAILS OPEN: `project` is null both while
 * the agent list loads (it is read non-blocking) and when nothing is scoped, so
 * hiding on null would blank three rows on every cold load and pop them back,
 * and would empty the unscoped org sidebar outright. Only a RESOLVED project
 * that has no source hides them.
 */
export function scopedProjectLacksSource(
  scopeId: string | null,
  project: { metadata?: unknown } | null,
): boolean {
  if (!scopeId || !project) return false;
  return !agentHasClonableSource(project.metadata);
}

/** Whether one of the project-aware destination rows survives sidebar
 * customization. Like the source gate above, this fails open until a scoped
 * project resolves so the non-blocking sidebar never disappears on cold load. */
export function scopedProjectDestinationEnabled(
  scopeId: string | null,
  project: { metadata?: ProjectSidebarViewsMetadata | null } | null,
  viewId: "overview" | "reports" | "board",
  optimisticViews?: readonly VirtualMcpSidebarView[],
): boolean {
  if (!scopeId || !project) return true;
  const hasOptimisticViews = optimisticViews !== undefined;
  return effectiveProjectSidebarViews(
    hasOptimisticViews
      ? optimisticViews
      : resolveProjectSidebarViews(project.metadata),
    hasOptimisticViews ? 1 : project.metadata?.sidebarViewsVersion,
  ).includes(viewId);
}

/** The destinations, in display order. Scope-bound in four ways: Library is
 *  org-only (it lists the ORG's files), Reports is project-only (a report is
 *  about one site), and Home / Reports / Tasks additionally require the scoped
 *  project to have a source and to select that row. The first two live in
 *  `routeExistsInScope`, because `useExitProjectScope` reads the same fact when
 *  clearing scope; the latter two are the pure gates above. */
function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();
  const scopeId = useScopeId();
  const { project } = useProjectScope();
  const optimisticSidebarViews = useOptimisticProjectSidebarViews(project?.id);

  const lacksSource = scopedProjectLacksSource(scopeId, project);
  const destinationEnabled = (viewId: "overview" | "reports" | "board") =>
    scopedProjectDestinationEnabled(
      scopeId,
      project,
      viewId,
      optimisticSidebarViews,
    );

  /** Keyed, not ordered — NAV_DESTINATION_KEYS fixes the order below. The
   *  record is exhaustive over that constant, so a key added there without a
   *  row here (or a row here the constant does not list) fails to compile.
   *  `null` is a row this scope drops. */
  const rows: Record<NavDestinationKey, NavDestination | null> = {
    overview:
      lacksSource || !destinationEnabled("overview")
        ? null
        : {
            key: "overview",
            label: t("sidebar.navDestinations.home"),
            icon: <Home02 size={16} />,
            isActive:
              leafPath === DESTINATION_ROUTE.home ||
              leafPath === DESTINATION_ROUTE.orgIndex,
            trackAs: "overview",
            link: { to: DESTINATION_ROUTE.home, params: { org: org.slug } },
          },
    reports:
      routeExistsInScope(DESTINATION_ROUTE.reports, scopeId) &&
      !lacksSource &&
      destinationEnabled("reports")
        ? {
            key: "reports",
            label: t("sidebar.navDestinations.reports"),
            icon: <BarChartSquare02 size={16} />,
            isActive: leafPath === DESTINATION_ROUTE.reports,
            trackAs: "reports",
            link: { to: DESTINATION_ROUTE.reports, params: { org: org.slug } },
          }
        : null,
    board:
      lacksSource || !destinationEnabled("board")
        ? null
        : {
            key: "board",
            label: t("sidebar.navDestinations.tasks"),
            icon: <Columns03 size={16} />,
            isActive: leafPath === DESTINATION_ROUTE.tasks,
            trackAs: "board",
            dataTour: LAYOUT_TOUR_ANCHORS.tasks,
            link: {
              to: DESTINATION_ROUTE.tasks,
              /** Explicitly cleared: params merge with the current match, so an open
               *  card would otherwise keep its segment and this link would go
               *  nowhere. Tasks means the lanes. */
              params: { org: org.slug, taskKey: undefined },
            },
          },
    files: routeExistsInScope(DESTINATION_ROUTE.library, scopeId)
      ? {
          key: "files",
          label: t("sidebar.navDestinations.library"),
          icon: <Folder size={16} />,
          isActive: leafPath === DESTINATION_ROUTE.library,
          trackAs: "files",
          link: { to: DESTINATION_ROUTE.library, params: { org: org.slug } },
        }
      : null,
  };

  return NAV_DESTINATION_KEYS.map((key) => rows[key]).filter(
    (row): row is NavDestination => row !== null,
  );
}

/** The destination list. New chat lives in the panel header (NewChatCrumb) and
 *  chat search lives in the chat panel's threads menu, so this renders
 *  destinations only. Collapsed, it becomes an icon rail — `SidebarNavRow`
 *  supplies the tooltips and the accessible names. */
export function NavDestinationsContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const destinations = useNavDestinations();

  return (
    <SidebarMenu className="gap-1">
      {destinations.map((item) => (
        <SidebarNavRow
          key={item.key}
          icon={item.icon}
          label={item.label}
          dataTour={item.dataTour}
          isActive={item.isActive}
          link={item.link}
          onSelect={() => {
            track("nav_destination_clicked", { destination: item.trackAs });
            onNavigate?.();
          }}
        />
      ))}
    </SidebarMenu>
  );
}
