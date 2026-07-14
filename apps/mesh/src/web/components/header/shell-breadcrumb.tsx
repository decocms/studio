/**
 * Shell breadcrumb — primary org/agent navigation in the toolbar: `org › agent`.
 *
 * - **org**   — the active organization's own icon *is* the switcher
 *   (Slack-style). Icon-only; the org name shows on hover. Opens the org
 *   switcher popover; selecting the current org returns to its home.
 * - **agent** — the active agent, always shown (the org's Super Agent by
 *   default). The avatar opens the agent's home; the label opens the agent
 *   picker. Inside a thread it snaps to that thread's agent. The sidebar always
 *   lists every thread regardless of the active agent.
 *
 * Renders inside `Toolbar.LeftColumn` — see `org-shell-layout`.
 */
import { Suspense } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ChevronDown } from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
} from "@deco/ui/components/breadcrumb.tsx";
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
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  OrgIcon,
  OrgSwitcherPopover,
} from "@/web/components/header/org-switcher";
import { AgentScopePicker } from "@/web/components/sidebar/agents-section";
import { BranchPill } from "@/web/components/chat/pills/branch-pill";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { authClient } from "@/web/lib/auth-client";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { findReusableNewChat } from "@/web/lib/reusable-new-chat";
import { usePendingInvitations } from "@/web/hooks/use-pending-invitations";

const crumbBtnClass =
  "wco-no-drag inline-flex items-center gap-1.5 min-w-0 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

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
    <div className="flex items-center gap-1">
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
            <span className="truncate font-medium max-w-[10rem]">{title}</span>
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
 * Branch crumb — the last segment (`… › agent › branch`), shown only inside a
 * thread whose agent is a sandbox agent (imported from GitHub with an attached
 * connection). Non-sandbox agents have no branch concept, so this renders
 * nothing. Reuses the chat's `BranchPill` with `placement="header"`.
 *
 * The breadcrumb lives above the `ChatContextProvider`, so it can't read the
 * chat task context. It resolves the active thread's branch + lock state from
 * the ThreadManager store instead (`harness_id != null` ⇒ runtime pinned ⇒
 * branch locked, matching `ChatTaskContextValue.isThreadLocked`).
 */
function BranchCrumb({ agentId, taskId }: { agentId: string; taskId: string }) {
  const entity = useVirtualMCP(agentId);
  const { threads } = useThreads();
  const { setBranch } = useThreadActions();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();

  const githubRepo = getActiveGithubRepo(entity);
  const connectionId = githubRepo?.connectionId;
  if (!githubRepo || !connectionId) return null;

  const activeTask = threads.find((t) => t.id === taskId);
  const userLabel = session?.user?.name ?? session?.user?.email?.split("@")[0];

  return (
    <BreadcrumbItem>
      <BranchPill
        orgId={org.id}
        orgSlug={org.slug}
        userId={session?.user?.id ?? ""}
        userLabel={userLabel}
        virtualMcpId={agentId}
        connectionId={connectionId}
        owner={githubRepo.owner}
        repo={githubRepo.name}
        sandboxMap={entity?.metadata?.sandboxMap}
        value={activeTask?.branch ?? null}
        onChange={(next) => void setBranch(taskId, next)}
        locked={activeTask?.harness_id != null}
        placement="header"
      />
    </BreadcrumbItem>
  );
}

export function ShellBreadcrumb() {
  const { org } = useProjectContext();
  const { state: sidebarState, isMobile } = useSidebar();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { threads } = useThreads();
  const { setTaskId, createNewTask } = usePanelActions();
  // Pending cross-org invitations surface inside the org switcher; show a dot on
  // its trigger so they're noticed without opening it.
  const hasPendingInvites = usePendingInvitations().invitations.length > 0;
  const isSidebarCollapsed = sidebarState === "collapsed" || isMobile;

  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);
  const decopilotId = decopilot.id;
  // The active agent is whatever the URL says: the thread's agent inside a
  // thread, else the Super Agent (= all) on the home. This is what makes the
  // selection survive a refresh — it lives in the URL, not React state.
  const activeAgentId = params.taskId
    ? (search.virtualmcpid ?? decopilotId)
    : decopilotId;

  const handlePickAgent = (id: string | null) => {
    // Decopilot / "all" → the org home (every thread, no agent filter).
    if (!id || id === decopilotId) {
      navigate({ to: "/$org", params: { org: org.slug } });
      return;
    }
    // Reuse this agent's existing empty "New chat" if it has one, else start
    // one — so re-selecting the same agent focuses the empty chat instead of
    // piling up duplicates. See findReusableNewChat for why status isn't gated.
    const existing = findReusableNewChat(threads, id);
    if (existing) {
      setTaskId(existing.id, id);
    } else {
      void createNewTask(id);
    }
  };

  return (
    <Breadcrumb className="wco-no-drag">
      <BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-1.5">
        {/* org icon = switcher (Slack-style). Icon-only; the name is on hover.
            The deco/product brand logo intentionally no longer lives here — the
            org's own identity anchors the top-left. */}
        <BreadcrumbItem>
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
                    // Extra left padding centers the org icon over the 56px
                    // collapsed sidebar rail below it (icons sit at ~28px from
                    // the shared left edge), so it lines up when the sidebar is
                    // closed.
                    className="wco-no-drag flex items-center gap-1.5 shrink-0 rounded-md pl-3 pr-1.5 py-1.5 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
        </BreadcrumbItem>

        {/* agent → avatar opens the agent home, label opens the picker */}
        <BreadcrumbItem>
          <Suspense
            fallback={
              <span className="h-5 w-24 rounded bg-muted animate-pulse" />
            }
          >
            <AgentCrumb
              agentId={activeAgentId}
              fallback={activeAgentId === decopilotId ? decopilot : undefined}
              onOpenHome={() => handlePickAgent(activeAgentId)}
              onPick={handlePickAgent}
            />
          </Suspense>
        </BreadcrumbItem>

        {/* branch → only inside a thread on a sandbox agent; hidden otherwise */}
        {params.taskId && (
          <Suspense fallback={null}>
            <BranchCrumb agentId={activeAgentId} taskId={params.taskId} />
          </Suspense>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
