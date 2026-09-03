/** Organization-owned destination rows. Agent-owned views live in
 * `ProjectNav`; these links never change meaning based on the active agent. */

import type { LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  BarChartSquare02,
  Columns03,
  Compass03,
  Folder,
  Home02,
} from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import {
  DESTINATION_ROUTE,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";
import { SidebarNavRow } from "./nav-row";

interface NavDestination {
  key: NavDestinationKey;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  /** Stable PostHog vocabulary; deliberately independent of the URL. */
  trackAs: string;
  link: LinkProps;
  dataTour?: string;
}

export const SETTINGS_DESTINATION = "settings";

/** Render order for the organization navigation spine. */
export const NAV_DESTINATION_KEYS = [
  "overview",
  "reports",
  "board",
  "files",
  "discover",
] as const;

type NavDestinationKey = (typeof NAV_DESTINATION_KEYS)[number];

function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();

  const rows: Record<NavDestinationKey, NavDestination> = {
    overview: {
      key: "overview",
      label: t("sidebar.navDestinations.home"),
      icon: <Home02 size={16} />,
      isActive:
        leafPath === DESTINATION_ROUTE.home ||
        leafPath === DESTINATION_ROUTE.orgIndex,
      trackAs: "overview",
      link: { to: DESTINATION_ROUTE.home, params: { org: org.slug } },
    },
    reports: {
      key: "reports",
      label: t("sidebar.navDestinations.reports"),
      icon: <BarChartSquare02 size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.reports,
      trackAs: "reports",
      link: { to: DESTINATION_ROUTE.reports, params: { org: org.slug } },
    },
    board: {
      key: "board",
      label: t("sidebar.navDestinations.tasks"),
      icon: <Columns03 size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.tasks,
      trackAs: "board",
      dataTour: LAYOUT_TOUR_ANCHORS.tasks,
      link: {
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: undefined },
      },
    },
    files: {
      key: "files",
      label: t("sidebar.navDestinations.library"),
      icon: <Folder size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.library,
      trackAs: "files",
      link: { to: DESTINATION_ROUTE.library, params: { org: org.slug } },
    },
    discover: {
      key: "discover",
      label: t("sidebar.navDestinations.discover"),
      icon: <Compass03 size={16} />,
      isActive: leafPath === DESTINATION_ROUTE.discover,
      trackAs: "discover",
      link: { to: DESTINATION_ROUTE.discover, params: { org: org.slug } },
    },
  };

  return NAV_DESTINATION_KEYS.map((key) => rows[key]);
}

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
