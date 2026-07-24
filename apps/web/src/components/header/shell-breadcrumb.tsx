/**
 * Org + agent navigation crumbs, used standalone so each can be placed
 * independently:
 *
 * - **{@link OrgSwitcherCrumb}** — the active organization's own icon *is* the
 *   switcher (Slack-style). Opens the org switcher popover. Lives in the desktop
 *   sidebar header and the mobile sidebar sheet.
 * - **{@link AgentSwitcherCrumb}** — the active agent (the org's Super Agent by
 *   default). The avatar opens the agent's home; the label opens the agent
 *   picker. Lives in the desktop topbar (when the sidebar is collapsed) and the
 *   mobile top header + sheet.
 */
import { Suspense } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ChevronDown, Edit05 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { OrgIcon, OrgSwitcherPopover } from "@/components/header/org-switcher";
import { AgentScopePicker } from "@/components/sidebar/agents-section";
import { useThreads } from "@/components/chat/store/hooks";
import { usePanelActions } from "@/layouts/shell-layout";
import { findReusableNewChat } from "@/lib/reusable-new-chat";
import { authClient } from "@/lib/auth-client.ts";
import { usePendingInvitations } from "@/hooks/use-pending-invitations";
import { useT } from "@/i18n/use-t.ts";

const crumbBtnClass =
  "wco-no-drag inline-flex items-center gap-1.5 min-w-0 rounded-md pl-1 pr-2 py-1.5 text-sm text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Agent crumb — resolves the active agent (thread's agent when inside a thread,
 * else the org's Super Agent). The avatar navigates to the agent's home (its
 * empty "New chat", or a fresh one); the label + chevron open the agent picker.
 * Suspends on the vMCP fetch, so it's wrapped in its own boundary and never
 * blocks the toolbar.
 *
 * `fallback` supplies the icon/title for a synthesized agent (the Super Agent
 * is never persisted, so `useVirtualMCP` returns null for it) — without it the
 * avatar would render a hash-based placeholder instead of the real icon.
 */
function AgentCrumb({
  agentId,
  fallback,
  onOpenHome,
  onPick,
}: {
  agentId: string;
  fallback?: VirtualMCPEntity;
  onOpenHome: () => void;
  onPick: (id: string | null) => void;
}) {
  const entity = useVirtualMCP(agentId) ?? fallback ?? null;
  const title = entity?.title ?? "Super Agent";
  return (
    <div className="flex min-w-0 items-center gap-0">
      <button
        type="button"
        onClick={onOpenHome}
        aria-label={`Open ${title} home`}
        className="wco-no-drag flex items-center shrink-0 rounded-md p-1 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <AgentAvatar
          icon={(entity?.icon as string | null) ?? null}
          name={title}
          size="xs"
        />
      </button>
      <AgentScopePicker
        side="bottom"
        align="start"
        selectedAgentId={agentId}
        onSelectAgent={onPick}
        trigger={
          <button type="button" className={crumbBtnClass}>
            <span className="truncate font-medium max-w-[8rem]">{title}</span>
            <ChevronDown
              size={14}
              className="shrink-0 text-muted-foreground opacity-70"
            />
          </button>
        }
      />
    </div>
  );
}

/**
 * Org switcher crumb — just the org icon button, standalone. Used in the
 * sidebar header; the agent crumb lives in the topbar.
 * The left padding aligns the icon's center with the sidebar trigger button
 * in the task list toolbar below it.
 */
export function OrgSwitcherCrumb({ showName }: { showName?: boolean } = {}) {
  const { org } = useProjectContext();
  const { state: sidebarState, isMobile } = useSidebar();
  const hasPendingInvites = usePendingInvitations().invitations.length > 0;
  const isSidebarCollapsed = sidebarState === "collapsed" || isMobile;

  return (
    <Tooltip>
      <OrgSwitcherPopover
        orgParam={org.slug}
        trigger={
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                hasPendingInvites
                  ? `${org.name} — switch organization (pending invitation)`
                  : `${org.name} — switch organization`
              }
              // pl-[5px] centers the 24px org icon on the same axis (x=25) as the
              // collapsed rail centers it (the 50px icon-rail's midpoint), so the
              // icon doesn't shift 1px when the sidebar collapses/expands.
              className="wco-no-drag flex items-center gap-1.5 shrink-0 rounded-lg pl-[5px] pr-1.5 py-1.5 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="relative inline-flex">
                <OrgIcon org={org} size="sm" />
                {hasPendingInvites && (
                  <span
                    className={cn(
                      "absolute -right-1 size-2.5 rounded-full bg-destructive ring-2 ring-background",
                      isSidebarCollapsed
                        ? "-top-1"
                        : "top-1/2 -translate-y-1/2",
                    )}
                  />
                )}
              </span>
              {showName && (
                <span className="truncate text-sm font-medium text-foreground max-w-[10rem]">
                  {org.name}
                </span>
              )}
              <ChevronDown
                size={14}
                className="shrink-0 text-muted-foreground opacity-70"
              />
            </button>
          </TooltipTrigger>
        }
      />
      <TooltipContent side="bottom">{org.name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Agent switcher crumb — just the agent avatar + name + picker, standalone.
 * Used in the topbar (desktop) and the mobile sidebar sheet header; the org
 * icon sits beside it. `onNavigate` fires after a pick so the mobile sheet can
 * close itself once an agent is chosen.
 */
export function AgentSwitcherCrumb({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { threads } = useThreads();
  const { data: session } = authClient.useSession();
  const { setTaskId, createNewTask } = usePanelActions();

  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);
  const decopilotId = decopilot.id;
  const activeAgentId = params.taskId
    ? (search.virtualmcpid ?? decopilotId)
    : decopilotId;

  const handlePickAgent = (id: string | null) => {
    if (!id || id === decopilotId) {
      navigate({ to: "/$org", params: { org: org.slug } });
      onNavigate?.();
      return;
    }
    const existing = findReusableNewChat(threads, id, session?.user?.id);
    if (existing) {
      setTaskId(existing.id, id);
    } else {
      void createNewTask(id);
    }
    onNavigate?.();
  };

  return (
    <Suspense
      fallback={<span className="h-5 w-24 rounded bg-muted animate-pulse" />}
    >
      <AgentCrumb
        agentId={activeAgentId}
        fallback={activeAgentId === decopilotId ? decopilot : undefined}
        onOpenHome={() => handlePickAgent(activeAgentId)}
        onPick={handlePickAgent}
      />
    </Suspense>
  );
}

/**
 * New-chat button — starts a fresh chat with the active agent (reusing an
 * existing empty "New chat" for it when there is one, so empties don't pile
 * up). Sibling of {@link AgentSwitcherCrumb}: shown in the same places (the
 * collapsed-sidebar topbar / chat header) so "new chat" stays reachable when
 * the sidebar's own new-chat action is tucked away.
 */
export function NewChatCrumb() {
  const t = useT();
  const { org } = useProjectContext();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { threads } = useThreads();
  const { data: session } = authClient.useSession();
  const { setTaskId, createNewTask } = usePanelActions();

  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const activeAgentId = params.taskId
    ? (search.virtualmcpid ?? decopilotId)
    : decopilotId;

  // A new chat inherits the branch of the thread being viewed, so it lands on
  // the same sandbox/branch. `null` on the home/agentless route (no active
  // thread) → server default.
  const currentBranch =
    (params.taskId
      ? threads.find((t) => t.id === params.taskId)?.branch
      : null) ?? null;

  const handleNewChat = () => {
    const existing = findReusableNewChat(
      threads,
      activeAgentId,
      session?.user?.id,
      currentBranch,
    );
    if (existing) {
      setTaskId(existing.id, activeAgentId);
    } else {
      void createNewTask(activeAgentId, currentBranch);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleNewChat}
          aria-label={t("sidebar.taskGroupsList.newChat")}
          className="wco-no-drag flex shrink-0 items-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Edit05 size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t("sidebar.taskGroupsList.newChat")}
      </TooltipContent>
    </Tooltip>
  );
}
