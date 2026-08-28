/**
 * The sidebar lists DESTINATIONS — Home, Reports, Tasks, Library — instead of
 * chat threads. Each is a real path (`/$org/home`, `/$org/reports`,
 * `/$org/tasks/{-$taskKey}`, `/$org/library`) under the governing rule: path =
 * which page, search = how that page is laid out. So every row is a genuine
 * `<Link>` anchor — cmd-click, middle-click and "Copy link address" all work —
 * and never a button that navigates imperatively.
 *
 * Nothing here creates a thread. Opening a destination or picking a project is
 * a navigation, not a conversation: the chat panel resolves its thread from
 * `?thread=`, and an absent one is a fresh composer with no row written.
 *
 * The org's coding agents (GitHub-backed virtual MCPs) trail the list, one row
 * per repo, linking to `/$org/agents/<agentId>` — those DO switch projects, since
 * each owns its own codebase. Agent rows also carry a
 * `showProjectSettingsGear`-gated gear onto that project's settings.
 *
 * Inbox is in the design but has no backing surface yet, so it is deliberately
 * not listed.
 */

import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import {
  BarChartSquare02,
  Columns03,
  Folder,
  Home02,
  Settings02,
} from "@untitledui/icons";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import {
  agentHasClonableSource,
  agentIsSidebarPinned,
  getDevAgentIds,
} from "@/lib/agent-capabilities";
import { getActiveGithubRepo } from "@/lib/github-repo";
import {
  DESTINATION_ROUTE,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useRouteProjectId, useRouteThreadId } from "@/layouts/thread-route";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface NavDestination {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  /** `nav_destination_clicked`'s `destination` property. PostHog dashboards key
   *  on these exact values, so they are decoupled from the route. */
  trackAs: string;
  link: LinkProps;
  /** When set, the row grows a hover-revealed gear opening this destination's
   *  settings. Only the agent rows have one — the fixed destinations are
   *  views, not configurable entities. */
  settingsLink?: LinkProps;
}

/** The destinations, in display order. */
function useNavDestinations(): NavDestination[] {
  const t = useT();
  const { org } = useProjectContext();
  const leafPath = useLeafRoutePath();

  const destination = (
    key: string,
    label: string,
    icon: ReactNode,
    isActive: boolean,
    link: LinkProps,
  ): NavDestination => ({ key, label, icon, isActive, trackAs: key, link });

  return [
    destination(
      "overview",
      t("sidebar.navDestinations.home"),
      <Home02 size={16} />,
      leafPath === DESTINATION_ROUTE.home ||
        leafPath === DESTINATION_ROUTE.orgIndex,
      { to: DESTINATION_ROUTE.home, params: { org: org.slug } },
    ),
    destination(
      "reports",
      t("sidebar.navDestinations.reports"),
      <BarChartSquare02 size={16} />,
      leafPath === DESTINATION_ROUTE.reports,
      { to: DESTINATION_ROUTE.reports, params: { org: org.slug } },
    ),
    destination(
      "board",
      t("sidebar.navDestinations.tasks"),
      <Columns03 size={16} />,
      leafPath === DESTINATION_ROUTE.tasks,
      {
        to: DESTINATION_ROUTE.tasks,
        /** Explicitly cleared: params merge with the current match, so an open
         *  card would otherwise keep its segment and this link would go
         *  nowhere. Tasks means the lanes. */
        params: { org: org.slug, taskKey: undefined },
      },
    ),
    destination(
      "files",
      t("sidebar.navDestinations.library"),
      <Folder size={16} />,
      leafPath === DESTINATION_ROUTE.library,
      { to: DESTINATION_ROUTE.library, params: { org: org.slug } },
    ),
  ];
}

/** Sidebar agent rows matching `predicate` (coding agents / org-pinned non-code); each links to that project's chat. */
function useAgentNavRows(
  predicate: (agent: VirtualMCPEntity, devAgentIds: Set<string>) => boolean,
): NavDestination[] {
  const { org } = useProjectContext();
  const agents = useVirtualMCPs() ?? [];
  const devAgentIds = getDevAgentIds(agents);
  const leafPath = useLeafRoutePath();
  /** The `{-$project}` segment of the matched route; absent off a scoped one. */
  const activeProject = useRouteProjectId();
  const routeThreadId = useRouteThreadId();

  return agents
    .filter((agent) => predicate(agent, devAgentIds))
    .map((agent) => {
      const repo = getActiveGithubRepo(agent);
      const isActive =
        leafPath === DESTINATION_ROUTE.agents && activeProject === agent.id;
      /**
       * Landing on a project is a navigation, so the row carries no thread —
       * the chat panel opens an empty composer. The exception is the row you
       * are already on: swapping the view there must not close the open chat.
       */
      const thread = isActive && routeThreadId ? routeThreadId : undefined;
      /** `panel: undefined` is deliberate: params merge with the current
       *  match, so a project row would otherwise carry the open view over to
       *  the project you are switching TO. */
      const params = { org: org.slug, project: agent.id, panel: undefined };
      return {
        key: agent.id,
        label: agent.title || repo?.name || "",
        icon: (
          <AgentAvatar
            icon={agent.icon}
            name={agent.title}
            size="2xs"
            className="shrink-0"
          />
        ),
        isActive,
        trackAs: "coding_agent",
        link: {
          to: DESTINATION_ROUTE.agents,
          params,
          search: thread ? { thread } : {},
        } satisfies LinkProps,
        settingsLink: {
          to: DESTINATION_ROUTE.agents,
          /** The Settings view — the target the agents list's row menu opens
           *  too. Named explicitly because params merge with the current match,
           *  so without it the link would keep whatever view is open. */
          params: { ...params, panel: "settings" },
          search: thread ? { thread } : {},
        } satisfies LinkProps,
      };
    });
}

/**
 * The destination list. New chat lives in the panel header (NewChatCrumb) and
 * chat search lives in the chat panel's threads menu, so this renders
 * destinations only. Collapsed, it becomes an icon rail — SidebarMenuButton
 * supplies the tooltips.
 */
export function NavDestinationsContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const t = useT();
  const destinations = useNavDestinations();
  const codingAgents = useAgentNavRows((agent) =>
    agentHasClonableSource(agent.metadata),
  );
  const pinnedAgents = useAgentNavRows(
    (agent, devAgentIds) =>
      agentIsSidebarPinned(agent) && !devAgentIds.has(agent.id),
  );
  const agentRows = [...codingAgents, ...pinnedAgents];
  const [{ showProjectSettingsGear }] = usePreferences();
  // Expanded, the label is right there — a tooltip repeating it is noise.
  const { state, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;

  const row = (item: NavDestination) => {
    // Opt-in per person; the icon rail has no room for a second control.
    const gear = item.settingsLink && showProjectSettingsGear && !isCollapsed;
    return (
      <SidebarMenuItem key={item.key}>
        <SidebarMenuButton
          asChild
          isActive={item.isActive}
          tooltip={isCollapsed ? item.label : undefined}
          className={cn(
            gear &&
              "group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground",
          )}
        >
          <Link
            {...item.link}
            aria-current={item.isActive ? "page" : undefined}
            onClick={() => {
              track("nav_destination_clicked", { destination: item.trackAs });
              onNavigate?.();
            }}
          >
            {item.icon}
            {/* Reserve the overlaid gear's width so the ellipsis clears it. */}
            <span className={cn("truncate", gear && "pr-7")}>{item.label}</span>
          </Link>
        </SidebarMenuButton>
        {gear && item.settingsLink && (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className={cn(
              // One tint throughout — only ghost's background reacts to hover.
              "absolute right-1 top-1/2 -translate-y-1/2 text-sidebar-foreground/60 hover:text-sidebar-foreground/60",
              // Hover-to-reveal has no touch equivalent.
              isMobile
                ? "opacity-100"
                : "opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100",
            )}
          >
            <Link
              {...item.settingsLink}
              aria-label={t("sidebar.navDestinations.projectSettings", {
                name: item.label,
              })}
              onClick={() => {
                track("nav_destination_clicked", {
                  destination: "coding_agent_settings",
                });
                onNavigate?.();
              }}
            >
              <Settings02 />
            </Link>
          </Button>
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarMenu className="gap-1">
      {destinations.map(row)}
      {agentRows.length > 0 && <li aria-hidden className="h-2" />}
      {agentRows.map(row)}
    </SidebarMenu>
  );
}
