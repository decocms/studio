/**
 * The sidebar lists DESTINATIONS — Home, Reports, Tasks, Library — instead of
 * chat threads. Each opens as the main panel's active view (`?main=<tabId>`),
 * the same mechanism the top tab bar uses. They are org-level, so they always
 * resolve on the Super Agent. Threads moved to the chat panel's own header (see
 * `ThreadsMenu`); Home, Automations and Settings left the top tab bar.
 *
 * The org's coding agents (GitHub-backed virtual MCPs) trail the list, one row
 * per repo — those DO switch agents, since each owns its own codebase.
 * Agent rows also carry a `showProjectSettingsGear`-gated gear onto settings.
 *
 * Inbox is in the design but has no backing surface yet, so it is deliberately
 * not listed.
 */

import type { ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
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
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import {
  agentHasClonableSource,
  agentIsSidebarPinned,
  getDevAgentIds,
} from "@/lib/agent-capabilities";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { findReusableNewChat } from "@/lib/reusable-new-chat";
import { useProjectDefaultRuntime } from "@/sdk/project-default-runtime";
import { defaultThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { authClient } from "@/lib/auth-client";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface NavDestination {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  onSelect: () => void;
  /** When set, the row grows a hover-revealed gear opening this destination's
   *  settings. Only the agent rows have one — the fixed destinations are
   *  views, not configurable entities. */
  onOpenSettings?: () => void;
}

/** The well-known Decopilot (Super Agent) id for the current org. */
function useDecopilotId(): string {
  const { org } = useProjectContext();
  return getWellKnownDecopilotVirtualMCP(org.id).id;
}

/** The destinations, in display order. */
function useNavDestinations({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}): NavDestination[] {
  const t = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    main?: string | 0;
    virtualmcpid?: string;
  };
  const { diagnostic, connectionId } = useCommerceDiagnostic();
  const decopilotId = useDecopilotId();
  const { threads } = useThreads();
  const { data: session } = authClient.useSession();
  const { setTaskId, createNewTask } = usePanelActions();
  const projectDefaultRuntime = useProjectDefaultRuntime();

  /**
   * These destinations are org-level, so they belong to the Super Agent. From a
   * coding agent's thread we must hand back to it — otherwise the panel would
   * show e.g. the Report while the header still carried that agent's
   * Preview / Publish controls.
   */
  const onSuperAgent =
    !search.virtualmcpid || search.virtualmcpid === decopilotId;

  const open = (tabId: string) => {
    track("nav_destination_clicked", { destination: tabId });
    onNavigate?.();
    if (onSuperAgent) {
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, main: tabId }),
        replace: true,
      });
      return;
    }
    // Reuse-or-create via setTaskId/createNewTask — same path useAgentNavRows uses.
    const existing = findReusableNewChat(
      threads,
      decopilotId,
      session?.user?.id,
      projectDefaultRuntime(decopilotId),
    );
    if (existing) setTaskId(existing.id, decopilotId, { main: tabId });
    else void createNewTask(decopilotId, undefined, { main: tabId });
  };

  /**
   * A cold `/$org` lands with no `main` at all, and the Super Agent's default
   * view IS Overview — so there, an absent `main` reads as Home rather than
   * leaving the list unhighlighted. On any other agent an absent `main` means
   * ITS default view (Preview for a coding agent), which is no destination at
   * all, so nothing highlights.
   */
  const activeKey =
    search.main === 0 || !search.main
      ? onSuperAgent
        ? "overview"
        : null
      : search.main;

  const destination = (
    key: string,
    label: string,
    icon: ReactNode,
  ): NavDestination => ({
    key,
    label,
    icon,
    isActive: activeKey === key,
    onSelect: () => open(key),
  });

  const destinations: NavDestination[] = [
    destination(
      "overview",
      t("sidebar.navDestinations.home"),
      <Home02 size={16} />,
    ),
  ];

  destinations.push(
    destination(
      diagnostic
        ? formatPinnedViewTabId(
            connectionId,
            COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
          )
        : "reports",
      t("sidebar.navDestinations.reports"),
      <BarChartSquare02 size={16} />,
    ),
  );
  destinations.push(
    destination(
      "board",
      t("sidebar.navDestinations.tasks"),
      <Columns03 size={16} />,
    ),
    destination(
      "files",
      t("sidebar.navDestinations.library"),
      <Folder size={16} />,
    ),
  );

  return destinations;
}

/** Sidebar agent rows matching `predicate` (coding agents / org-pinned non-code); selecting one opens its chat, reusing an empty "New chat". */
function useAgentNavRows(
  predicate: (agent: VirtualMCPEntity, devAgentIds: Set<string>) => boolean,
  {
    onNavigate,
  }: {
    onNavigate?: () => void;
  } = {},
): NavDestination[] {
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const agents = useVirtualMCPs() ?? [];
  const devAgentIds = getDevAgentIds(agents);
  const { threads } = useThreads();
  const { data: session } = authClient.useSession();
  const { setTaskId, createNewTask, openTab } = usePanelActions();

  /**
   * Open the agent's chat, optionally landing on a specific main view. Reuses
   * the agent's existing empty "New chat" so repeat clicks don't pile up
   * threads; `opts.main` beats that thread's remembered layout (see
   * resolveTaskSwitchSearch), so the gear always lands on Settings.
   */
  const openAgent = (
    agent: VirtualMCPEntity,
    opts?: { main?: string },
  ): void => {
    onNavigate?.();
    const existing = findReusableNewChat(
      threads,
      agent.id,
      session?.user?.id,
      defaultThreadRuntime(agent.metadata),
    );
    if (existing) setTaskId(existing.id, agent.id, opts);
    else void createNewTask(agent.id, undefined, opts);
  };

  return agents
    .filter((agent) => predicate(agent, devAgentIds))
    .map((agent) => {
      const repo = getActiveGithubRepo(agent);
      const isActive = search.virtualmcpid === agent.id;
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
        onSelect: () => {
          track("nav_destination_clicked", { destination: "coding_agent" });
          openAgent(agent);
        },
        onOpenSettings: () => {
          track("nav_destination_clicked", {
            destination: "coding_agent_settings",
          });
          // `?main=settings` — the target the agents list's row menu opens too.
          if (isActive) {
            // Already on this agent: swap the view, keep the open thread.
            onNavigate?.();
            openTab("settings");
          } else {
            openAgent(agent, { main: "settings" });
          }
        },
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
  const destinations = useNavDestinations({ onNavigate });
  const codingAgents = useAgentNavRows(
    (agent) => agentHasClonableSource(agent.metadata),
    { onNavigate },
  );
  const pinnedAgents = useAgentNavRows(
    (agent, devAgentIds) =>
      agentIsSidebarPinned(agent) && !devAgentIds.has(agent.id),
    { onNavigate },
  );
  const agentRows = [...codingAgents, ...pinnedAgents];
  const [{ showProjectSettingsGear }] = usePreferences();
  // Expanded, the label is right there — a tooltip repeating it is noise.
  const { state, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;

  const row = (item: NavDestination) => {
    // Opt-in per person; the icon rail has no room for a second control.
    const gear = item.onOpenSettings && showProjectSettingsGear && !isCollapsed;
    return (
      <SidebarMenuItem key={item.key}>
        <SidebarMenuButton
          onClick={item.onSelect}
          isActive={item.isActive}
          aria-current={item.isActive ? "page" : undefined}
          tooltip={isCollapsed ? item.label : undefined}
          className={cn(
            gear &&
              "group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground",
          )}
        >
          {item.icon}
          {/* Reserve the overlaid gear's width so the ellipsis clears it. */}
          <span className={cn("truncate", gear && "pr-7")}>{item.label}</span>
        </SidebarMenuButton>
        {gear && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("sidebar.navDestinations.projectSettings", {
              name: item.label,
            })}
            onClick={item.onOpenSettings}
            className={cn(
              // One tint throughout — only ghost's background reacts to hover.
              "absolute right-1 top-1/2 -translate-y-1/2 text-sidebar-foreground/60 hover:text-sidebar-foreground/60",
              // Hover-to-reveal has no touch equivalent.
              isMobile
                ? "opacity-100"
                : "opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100",
            )}
          >
            <Settings02 />
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
