import { Suspense, useState, type ReactElement } from "react";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { CollectionSearch } from "@deco/ui/components/collection-search.tsx";
import { Check, Plus } from "@untitledui/icons";
import {
  getWellKnownDecopilotVirtualMCP,
  isDecopilot,
  isStudioPackAgent,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { track } from "@/web/lib/posthog-client";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { authClient } from "@/web/lib/auth-client";
import { getServerPinnedIds } from "@/web/hooks/use-navigate-to-agent";
import { getDevAgentIds } from "@/web/lib/agent-capabilities";
import {
  useSidebarAgentGroupsEmpty,
  useBumpSidebarOrderRevision,
} from "./sidebar-agent-groups-context";
import { appendAgentToPersonalOrder } from "./task-groups/stable-order";

const EMPTY_SIDEBAR_HINT = "Select an existing agent";

function BrowseAgentsEmptyHint({ children }: { children: ReactElement }) {
  return (
    <Tooltip defaultOpen delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {EMPTY_SIDEBAR_HINT}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Hook for "spawn task on this vMCP" buttons (used by the browse-agents
 * popover). When the user clicks a vMCP that matches the URL's current
 * virtualmcpid, the active task's branch is carried into the new thread
 * so the new task lands on the same warm sandbox. When the clicked vMCP
 * differs, no branch is passed and the server picks the most-recently-
 * touched sandboxMap entry for that vMCP.
 */
function useNavigateToNewTaskWithBranchCarry(orgSlug: string) {
  const navigate = useNavigate();
  const { create } = useThreadActions();
  const { locator } = useProjectContext();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };

  return async (clickedVirtualMcpId: string) => {
    const taskId = crypto.randomUUID();
    const carryBranch =
      clickedVirtualMcpId === search.virtualmcpid
        ? readCachedTaskBranch(orgSlug, locator, params.taskId ?? "")
        : null;
    try {
      await create({
        id: taskId,
        virtual_mcp_id: clickedVirtualMcpId,
        ...(carryBranch ? { branch: carryBranch } : {}),
      });
    } catch {
      // Toast already fired; navigate anyway so the route loader's
      // ensure-fallback can retry.
    }
    navigate({
      to: "/$org/$taskId",
      params: { org: orgSlug, taskId },
      search: { virtualmcpid: clickedVirtualMcpId },
    });
  };
}

function AgentRow({
  agent,
  selected,
  onClick,
}: {
  agent: VirtualMCPEntity;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left w-full transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/50",
      )}
    >
      <AgentAvatar
        icon={agent.icon}
        name={agent.title}
        size="xs"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{agent.title}</p>
        {agent.description && (
          <p className="text-xs text-muted-foreground truncate">
            {agent.description}
          </p>
        )}
      </div>
      {selected && (
        <Check size={14} className="ml-auto text-muted-foreground shrink-0" />
      )}
    </button>
  );
}

function PinAgentPopoverContent({
  onClose,
  onSelectAgent,
  selectedAgentId,
}: {
  onClose: () => void;
  /** When provided (breadcrumb scope picker), selecting an agent sets the
   * sidebar scope instead of opening a new task; `null` = all agents. The list
   * then leads with a Decopilot row ("all threads") and marks the active one. */
  onSelectAgent?: (id: string | null) => void;
  /** The currently-scoped agent, for the check mark (picker mode). */
  selectedAgentId?: string | null;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const agents = allAgents ?? [];
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const sidebarUserId = session?.user?.id ?? "anon";
  const serverPinnedIds = getServerPinnedIds(allAgents);
  const bumpOrderRevision = useBumpSidebarOrderRevision();

  const navigateToNewTask = useNavigateToNewTaskWithBranchCarry(org.slug);

  // Dev agents are reached via the Develop/Live toggle on their live
  // counterpart, not as standalone browse entries.
  const devAgentIds = getDevAgentIds(allAgents);
  const lowerSearch = search.toLowerCase();
  const userAgents = agents
    .filter((s) => !isDecopilot(s.id))
    .filter((s) => !devAgentIds.has(s.id))
    // Studio Pack default agents (Usage/Automation/Agent/Connection/Store/Brand
    // Manager) live only on the agents page, not this browse list.
    .filter((s) => !isStudioPackAgent(s.id))
    .filter((s) => !search || s.title.toLowerCase().includes(lowerSearch));

  // Decopilot — the "all threads / every agent" option in scope-picker mode.
  // The well-known agent isn't in the collection list, so build it directly.
  const decopilotAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const showDecopilot =
    !search || decopilotAgent.title.toLowerCase().includes(lowerSearch);
  // Decopilot only renders in scope-picker mode; when it's shown the list is
  // never truly empty, so the "No agents yet" hint would be misleading.
  const decopilotRowShown = Boolean(onSelectAgent && showDecopilot);

  const selectAll = () => {
    onSelectAgent?.(null);
    onClose();
    setSearch("");
  };

  const handleSelect = (agent: VirtualMCPEntity) => {
    // Scope-picker mode (breadcrumb): set the sidebar filter, don't open a task.
    if (onSelectAgent) {
      onSelectAgent(agent.id);
      onClose();
      setSearch("");
      return;
    }
    appendAgentToPersonalOrder(
      { orgId: org.id, userId: sidebarUserId },
      agent.id,
      serverPinnedIds,
    );
    bumpOrderRevision();
    onClose();
    setSearch("");
    navigateToNewTask(agent.id);
  };

  return (
    <div className="flex flex-col max-h-[min(640px,80dvh)]">
      {/* Search */}
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search agents..."
      />

      {/* Scrollable content */}
      <div className="overflow-y-auto flex-1 min-h-0 p-1.5 flex flex-col gap-1">
        {/* Scope-picker mode: Decopilot = all threads, every agent. */}
        {onSelectAgent && showDecopilot && decopilotAgent && (
          <AgentRow
            agent={decopilotAgent}
            selected={!selectedAgentId || selectedAgentId === decopilotAgent.id}
            onClick={selectAll}
          />
        )}

        {userAgents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            selected={onSelectAgent ? selectedAgentId === agent.id : undefined}
            onClick={() => handleSelect(agent)}
          />
        ))}

        {userAgents.length === 0 && !decopilotRowShown && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            {search ? "No agents found" : "No agents yet"}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2.5">
        <Link
          to="/$org/settings/agents"
          params={{ org: org.slug }}
          onClick={() => onClose()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
        >
          See all agents
        </Link>
      </div>
    </div>
  );
}

function PinAgentPopover({
  compact = false,
  trigger,
  onSelectAgent,
  selectedAgentId,
  side = "right",
  align = "start",
}: {
  compact?: boolean;
  /** Custom trigger (e.g. the breadcrumb agent crumb); defaults to the "+" btn. */
  trigger?: ReactElement;
  /** Scope-picker mode: set the sidebar agent filter instead of opening a task. */
  onSelectAgent?: (id: string | null) => void;
  selectedAgentId?: string | null;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
} = {}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const highlightEmpty = useSidebarAgentGroupsEmpty();
  const emptyCtaClass = highlightEmpty ? "border border-border" : undefined;

  const wrapEmptyHint = (trigger: ReactElement) =>
    highlightEmpty ? (
      <BrowseAgentsEmptyHint>{trigger}</BrowseAgentsEmptyHint>
    ) : (
      trigger
    );

  const handleClose = () => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
  };

  const popoverContent = open && (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-8">
          <Skeleton className="h-4 w-24" />
        </div>
      }
    >
      <PinAgentPopoverContent
        onClose={handleClose}
        onSelectAgent={onSelectAgent}
        selectedAgentId={selectedAgentId}
      />
    </Suspense>
  );

  return (
    <>
      {isMobile ? (
        <>
          {trigger ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="contents"
            >
              {trigger}
            </button>
          ) : compact ? (
            wrapEmptyHint(
              <ToolbarIconButton
                aria-label="Browse agents"
                className={cn(emptyCtaClass)}
                onClick={() => {
                  track("agent_browser_opened", { surface: "mobile_drawer" });
                  setOpen(true);
                }}
              >
                <Plus className="size-4" />
              </ToolbarIconButton>,
            )
          ) : (
            <SidebarMenuItem>
              {wrapEmptyHint(
                <SidebarMenuButton
                  tooltip={highlightEmpty ? undefined : "Browse agents"}
                  className={cn(emptyCtaClass)}
                  onClick={() => {
                    track("agent_browser_opened", { surface: "mobile_drawer" });
                    setOpen(true);
                  }}
                >
                  <Plus />
                  <span>New agent</span>
                </SidebarMenuButton>,
              )}
            </SidebarMenuItem>
          )}
          <Drawer open={open} onOpenChange={setOpen} direction="bottom">
            <DrawerContent className="max-h-[85dvh] p-0">
              <DrawerTitle className="sr-only">Browse agents</DrawerTitle>
              {popoverContent}
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next && !open) {
              track("agent_browser_opened", { surface: "desktop_popover" });
            }
            setOpen(next);
          }}
        >
          {trigger ? (
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          ) : compact ? (
            wrapEmptyHint(
              <PopoverTrigger asChild>
                <ToolbarIconButton
                  aria-label="Browse agents"
                  className={cn(emptyCtaClass)}
                >
                  <Plus className="size-4" />
                </ToolbarIconButton>
              </PopoverTrigger>,
            )
          ) : (
            <SidebarMenuItem>
              {wrapEmptyHint(
                <PopoverTrigger asChild>
                  <SidebarMenuButton
                    tooltip={highlightEmpty ? undefined : "Browse agents"}
                    className={cn(emptyCtaClass)}
                  >
                    <Plus />
                    <span>New agent</span>
                  </SidebarMenuButton>
                </PopoverTrigger>,
              )}
            </SidebarMenuItem>
          )}
          <PopoverContent
            className="w-[380px] p-0 overflow-hidden"
            side={side}
            align={align}
          >
            {popoverContent}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

/**
 * AgentScopePicker — the agent drawer, used from the toolbar breadcrumb as a
 * scope selector (ordered list of rows, Decopilot first). Pass a `trigger` (the
 * agent crumb) and `onSelectAgent`/`selectedAgentId`; `null` = all agents.
 */
export { PinAgentPopover as AgentScopePicker };
