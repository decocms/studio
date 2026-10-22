/** The org-wide destination rows: real `<Link>`s, so nav paints on the first
 *  frame. Projects are a tree below these, not rows here.
 *
 *  Reports, Board and Settings are reached FROM these rather than listed
 *  beside them: a spine of five equal rows gave all five the same weight,
 *  which made the brief read as a tab. Library is the exception: it is a place
 *  you go to on purpose, not something a row above leads to. */

import type { ReactNode } from "react";
import type { LinkProps } from "@tanstack/react-router";
import {
  Activity,
  Columns03,
  Folder,
  Home02,
  Lock01,
  Target04,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
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
  /** Announced but not built: the row opens a coming-soon page. */
  soon?: boolean;
}

/** Settings has no row any more, but the VALUE stays: PostHog dashboards key
 *  on it, and its replacement should report as the same series. */
export const SETTINGS_DESTINATION = "settings";

/** The display order `useNavDestinations` maps over. The keyed record below is
 *  exhaustive over it, so the two cannot drift. */
export const NAV_DESTINATION_KEYS = [
  "overview",
  "files",
  "plan",
  "tasks",
  "monitor",
] as const;

type NavDestinationKey = (typeof NAV_DESTINATION_KEYS)[number];

/** The destinations, in display order. */
function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();
  const scopeId = useScopeId();

  /** Keyed, not ordered — `NAV_DESTINATION_KEYS` fixes the order below. */
  const rows: Record<NavDestinationKey, NavDestination> = {
    overview: {
      key: "overview",
      label: t("sidebar.navDestinations.overview"),
      icon: <Home02 size={16} />,
      /** Inside a project, the rows are that project's. */
      isActive: scopeId
        ? leafPath === PROJECT_ROUTE.root ||
          leafPath === `${PROJECT_ROUTE.root}/`
        : leafPath === DESTINATION_ROUTE.home ||
          leafPath === DESTINATION_ROUTE.orgIndex,
      trackAs: "overview",
      link: scopeId
        ? {
            to: PROJECT_ROUTE.root,
            params: { org: org.slug, agentId: scopeId },
          }
        : { to: DESTINATION_ROUTE.home, params: { org: org.slug } },
    },
    plan: {
      key: "plan",
      label: t("sidebar.navDestinations.plan"),
      icon: <Target04 size={16} />,
      isActive:
        leafPath === DESTINATION_ROUTE.plan || leafPath === PROJECT_ROUTE.plan,
      trackAs: "plan",
      soon: true,
      link: scopeId
        ? {
            to: PROJECT_ROUTE.plan,
            params: { org: org.slug, agentId: scopeId },
          }
        : { to: DESTINATION_ROUTE.plan, params: { org: org.slug } },
    },
    tasks: {
      key: "tasks",
      label: t("sidebar.navDestinations.spineTasks"),
      icon: <Columns03 size={16} />,
      isActive:
        leafPath === DESTINATION_ROUTE.tasks ||
        leafPath === PROJECT_ROUTE.tasks,
      trackAs: "board",
      link: scopeId
        ? {
            to: PROJECT_ROUTE.tasks,
            params: { org: org.slug, agentId: scopeId, taskKey: undefined },
          }
        : {
            to: DESTINATION_ROUTE.tasks,
            params: { org: org.slug, taskKey: undefined },
          },
    },
    monitor: {
      key: "monitor",
      label: t("sidebar.navDestinations.monitor"),
      icon: <Activity size={16} />,
      isActive:
        leafPath === DESTINATION_ROUTE.monitoring ||
        leafPath === PROJECT_ROUTE.monitoring,
      trackAs: "monitor",
      soon: true,
      link: scopeId
        ? {
            to: PROJECT_ROUTE.monitoring,
            params: { org: org.slug, agentId: scopeId },
          }
        : { to: DESTINATION_ROUTE.monitoring, params: { org: org.slug } },
    },
    /** A project's Context is its own folder and settings; the org's is the drive. */
    files: {
      key: "files",
      label: t("sidebar.navDestinations.context"),
      icon: <Folder size={16} />,
      isActive:
        leafPath === DESTINATION_ROUTE.library ||
        leafPath === PROJECT_ROUTE.library,
      trackAs: "files",
      link: scopeId
        ? {
            to: PROJECT_ROUTE.library,
            params: { org: org.slug, agentId: scopeId },
          }
        : { to: DESTINATION_ROUTE.library, params: { org: org.slug } },
    },
  };

  return NAV_DESTINATION_KEYS.map((key) => rows[key]);
}

/** The destination list; chat opens from the sidebar header instead.
 *  Collapsed it becomes an icon rail, with tooltips from `SidebarNavRow`. */
export function NavDestinationsContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const t = useT();
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
            item.soon ? (
              <Badge variant="muted">{t("common.soon")}</Badge>
            ) : isLocked(item.key) ? (
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
