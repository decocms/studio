/** The org-wide destination rows: real `<Link>`s, so nav paints on the first
 *  frame. Projects are a tree below these, not rows here.
 *
 *  Reports, Board and Settings are reached FROM these rather than listed
 *  beside them: a spine of five equal rows gave all five the same weight,
 *  which made the brief read as a tab. Library is the exception: it is a place
 *  you go to on purpose, not something a row above leads to. */

import type { ReactNode } from "react";
import { useSearch, type LinkProps } from "@tanstack/react-router";
import { Columns03, Folder, Home02, Lock01, Zap } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { useTabLocked } from "./use-tab-locked";
import { useProjectContext } from "@/sdk";
import { useScopeId } from "@/hooks/use-project-scope";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
  routeExistsInScope,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface NavDestination {
  key: NavDestinationKey;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  /** `nav_destination_clicked`'s `destination` property. PostHog dashboards key
   *  on these exact values, so they are decoupled from the route. */
  trackAs: string;
  link: LinkProps;
}

/** Settings has no row any more, but the VALUE stays: PostHog dashboards key
 *  on it, and its replacement should report as the same series. */
export const SETTINGS_DESTINATION = "settings";

/** The display order `useNavDestinations` maps over. The keyed record below is
 *  exhaustive over it, so the two cannot drift. */
export const NAV_DESTINATION_KEYS = ["overview", "tasks", "agents", "files"] as const;

type NavDestinationKey = (typeof NAV_DESTINATION_KEYS)[number];

/** The destinations, in display order. */
function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();
  const scopeId = useScopeId();
  const { view } = useSearch({ strict: false }) as { view?: "agents" };

  /** Keyed, not ordered — `NAV_DESTINATION_KEYS` fixes the order below. */
  const rows: Record<NavDestinationKey, NavDestination | null> = {
    overview: {
      key: "overview",
      label: t("sidebar.navDestinations.today"),
      icon: <Home02 size={16} />,
      /** Inside a project this row IS the board, so it also lights up on the
       *  board's own route — that is where a card deep-link lands. */
      isActive:
        (leafPath === DESTINATION_ROUTE.home && view !== "agents") ||
        leafPath === DESTINATION_ROUTE.orgIndex ||
        leafPath === PROJECT_ROUTE.root ||
        leafPath === `${PROJECT_ROUTE.root}/` ||
        (!!scopeId && leafPath === PROJECT_ROUTE.tasks),
      trackAs: "overview",
      link: {
        to: DESTINATION_ROUTE.home,
        params: { org: org.slug },
        search: { view: undefined },
      },
    },
    tasks: {
      key: "tasks",
      label: t("sidebar.navDestinations.spineTasks"),
      icon: <Columns03 size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.tasks,
      trackAs: "board",
      link: {
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: undefined },
      },
    },
    /** Same ROUTE as Today, told apart by `?view=`, so both rows key their
     *  active state on the search rather than the path. */
    agents: {
      key: "agents",
      label: t("sidebar.navDestinations.agents"),
      icon: <Zap size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.home && view === "agents",
      trackAs: "agents",
      link: {
        to: DESTINATION_ROUTE.home,
        params: { org: org.slug },
        search: { view: "agents" as const },
      },
    },
    /** Org-only: it lists the ORG's files, so a project scope drops the row. */
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

/** The destination list; chat opens from the sidebar header instead.
 *  Collapsed it becomes an icon rail, with tooltips from `SidebarNavRow`. */
export function NavDestinationsContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const destinations = useNavDestinations();
  const isLocked = useTabLocked();

  return (
    <SidebarMenu className="gap-1">
      {destinations.map((item) => (
        <SidebarNavRow
          key={item.key}
          icon={item.icon}
          label={item.label}
          isActive={item.isActive}
          link={item.link}
          trailing={
            isLocked(item.key) ? (
              <Lock01 size={14} className="text-muted-foreground" />
            ) : undefined
          }
          onSelect={() => {
            track("nav_destination_clicked", { destination: item.trackAs });
            onNavigate?.();
          }}
        />
      ))}
    </SidebarMenu>
  );
}
