/**
 * First-class navigation (see `useNavV2`).
 *
 * The sidebar lists DESTINATIONS — Home, Reports, Tasks, Library — instead of
 * chat threads. Each opens as the main panel's active view on the current
 * thread (`?main=<tabId>`), the same mechanism the top tab bar uses, so neither
 * switches agents. Threads moved to the chat panel's own header (see
 * `ThreadsMenu`); Home, Automations and Settings left the top tab bar.
 *
 * The org's coding agents (GitHub-backed virtual MCPs) trail the list, one row
 * per repo — those DO switch agents, since each owns its own codebase.
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
  Globe01,
  Home02,
} from "@untitledui/icons";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { COMMERCE_DISCOVERY_REPORT_TOOL_NAME, useVirtualMCPs } from "@/sdk";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { findReusableNewChat } from "@/lib/reusable-new-chat";
import { authClient } from "@/lib/auth-client";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface NavDestination {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  onSelect: () => void;
}

/**
 * The destinations, in display order. Reports only appears once the org
 * actually has a report — the entry opens that report's MCP app.
 */
function useNavDestinations({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}): NavDestination[] {
  const t = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { main?: string | 0 };
  const { diagnostic, connectionId } = useCommerceDiagnostic();

  const open = (tabId: string) => {
    track("nav_destination_clicked", { destination: tabId });
    onNavigate?.();
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: tabId }),
      replace: true,
    });
  };

  /**
   * A cold `/$org` lands with no `main` at all, showing the landing agent's
   * default view — Overview for the Super Agent, which is the only agent this
   * navigation exposes. So an absent `main` reads as Home rather than leaving
   * the whole list unhighlighted.
   */
  const activeKey =
    search.main === 0 || !search.main ? "overview" : search.main;

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

  if (diagnostic) {
    destinations.push(
      destination(
        formatPinnedViewTabId(
          connectionId,
          COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
        ),
        t("sidebar.navDestinations.reports"),
        <BarChartSquare02 size={16} />,
      ),
    );
  }
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

/**
 * The org's coding agents — every virtual MCP backed by a GitHub repo (imported
 * from GitHub or cloned from a template). Each is listed by REPO name, since
 * that is what identifies the codebase the agent works on.
 *
 * Selecting one opens that agent's chat, reusing its existing empty "New chat"
 * so repeat clicks don't pile up threads.
 */
function useCodingAgents({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}): NavDestination[] {
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const agents = useVirtualMCPs() ?? [];
  const { threads } = useThreads();
  const { data: session } = authClient.useSession();
  const { setTaskId, createNewTask } = usePanelActions();

  return agents
    .filter((agent) => agentHasClonableSource(agent.metadata))
    .map((agent) => {
      const repo = getActiveGithubRepo(agent);
      return {
        key: agent.id,
        label: repo?.name || agent.title,
        icon: <Globe01 size={16} />,
        isActive: search.virtualmcpid === agent.id,
        onSelect: () => {
          track("nav_destination_clicked", { destination: "coding_agent" });
          onNavigate?.();
          const existing = findReusableNewChat(
            threads,
            agent.id,
            session?.user?.id,
          );
          if (existing) setTaskId(existing.id, agent.id);
          else void createNewTask(agent.id);
        },
      };
    });
}

/**
 * The destination list. New chat lives on the toolbar row above it (see
 * NavSidebarContent) and chat search lives in the chat panel's threads menu, so
 * this renders destinations only. Collapsed, it becomes an icon rail —
 * SidebarMenuButton supplies the tooltips.
 */
export function NavDestinationsContent({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const destinations = useNavDestinations({ onNavigate });
  const codingAgents = useCodingAgents({ onNavigate });

  const row = (item: NavDestination) => (
    <SidebarMenuItem key={item.key}>
      <SidebarMenuButton
        onClick={item.onSelect}
        isActive={item.isActive}
        tooltip={item.label}
      >
        {item.icon}
        <span className="truncate">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <SidebarMenu className="gap-1.5">
      {destinations.map(row)}
      {codingAgents.length > 0 && <li aria-hidden className="h-3" />}
      {codingAgents.map(row)}
    </SidebarMenu>
  );
}
