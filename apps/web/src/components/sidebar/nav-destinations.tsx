/** The org-wide destination rows: real `<Link>`s, so nav paints on the first
 *  frame. Projects are a tree below these, not rows here.
 *
 *  Two of them, and two is the point. Today is the daily brief — what changed
 *  and what is stopped on you. Agents is the machine — what is running right
 *  now and what runs without being asked. Everything the sidebar used to list
 *  beside them (Reports, Board, Library, Settings) is either a place you reach
 *  FROM one of those two, or an org utility that belongs in a group of its own;
 *  a spine of five equal rows made all five read as the same weight, which is
 *  how a brief ends up looking like a tab. */

import type { ReactNode } from "react";
import { useSearch, type LinkProps } from "@tanstack/react-router";
import { Columns03, Home02, Lock01, Zap } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { SidebarNavRow } from "./nav-row";
import { useTabLocked } from "./use-tab-locked";
import { useProjectContext } from "@/sdk";
import { useScopeId } from "@/hooks/use-project-scope";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
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

/**
 * `nav_destination_clicked`'s `destination` for the Settings row.
 *
 * Settings no longer has a row — it is reached from the account footer and by
 * URL until the org utility group is designed. The VALUE stays because PostHog
 * dashboards key on it, and because whatever control replaces the row should
 * keep reporting as the same destination rather than starting a new series.
 */
export const SETTINGS_DESTINATION = "settings";

/** The destination keys, in display order — and the order the sidebar actually
 *  renders, since `useNavDestinations` maps over this rather than returning a
 *  literal array. Growing or shrinking it is a compile error until the keyed
 *  record below matches, so a test asserting on it pins the real spine. */
export const NAV_DESTINATION_KEYS = ["overview", "tasks", "agents"] as const;

type NavDestinationKey = (typeof NAV_DESTINATION_KEYS)[number];

/** The destinations, in display order. */
function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();
  const scopeId = useScopeId();
  const { view } = useSearch({ strict: false }) as { view?: "agents" };

  /** Keyed, not ordered — NAV_DESTINATION_KEYS fixes the order below. The
   *  record is exhaustive over that constant, so a key added there without a
   *  row here (or a row here the constant does not list) fails to compile. */
  const rows: Record<NavDestinationKey, NavDestination> = {
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
      label: t("sidebar.navDestinations.tasks"),
      icon: <Columns03 size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.tasks,
      trackAs: "board",
      link: {
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: undefined },
      },
    },
    /** Same ROUTE as Today, told apart by `?view=` — see that param's note in
     *  `router.tsx`. So both rows key their active state on the search, not on
     *  the path, or Today would light up on both. */
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
  };

  return NAV_DESTINATION_KEYS.map((key) => rows[key]);
}

/** The destination list. Chat opens from the sidebar header, and
 *  chat search lives in the chat panel's threads menu, so this renders
 *  destinations only. Collapsed, it becomes an icon rail — `SidebarNavRow`
 *  supplies the tooltips and the accessible names. */
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
