import { Suspense, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { CollectionSearch } from "@deco/ui/components/collection-search.tsx";
import { Plus, Settings01, X } from "@untitledui/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { useCreateTaskAndNavigate } from "@/web/hooks/use-create-task-and-navigate";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { SiteEditorOnboardingModal } from "@/web/components/home/site-editor-onboarding-modal.tsx";
import { useAgentBadges } from "@/web/hooks/use-agent-badges";

const SITE_EDITOR_AGENT = {
  id: "site-editor",
  title: "Site Editor",
  icon: "icon://Globe01?color=violet",
} as const;

const DEFAULT_AGENTS = [SITE_EDITOR_AGENT];

function AgentListItem({
  agent,
  org,
  hasBadge,
  onMarkSeen,
}: {
  agent: VirtualMCPEntity;
  org: string;
  hasBadge?: boolean;
  onMarkSeen?: () => void;
}) {
  const navigate = useNavigate();
  const navigateToNewTask = useCreateTaskAndNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = pathname.startsWith(`/${org}/${agent.id}`);
  const actions = useVirtualMCPActions();
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const xRef = useRef<HTMLButtonElement>(null);
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleIconMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    showTimeoutRef.current = setTimeout(() => {
      setButtonRect(rect);
    }, 550);
  };

  const handleIconMouseLeave = (e: React.MouseEvent) => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (
      xRef.current &&
      e.relatedTarget instanceof Node &&
      xRef.current.contains(e.relatedTarget)
    ) {
      return;
    }
    setButtonRect(null);
  };

  const xVisibleWidth = buttonRect ? Math.round(buttonRect.height * 0.9) : 0;
  const xTotalWidth = buttonRect ? buttonRect.width + xVisibleWidth : 0;

  return (
    <ContextMenu>
      <SidebarMenuItem className={cn(buttonRect && "z-[55]")}>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={buttonRect ? undefined : agent.title}
            isActive={isActive}
            onClick={() => {
              onMarkSeen?.();
              navigateToNewTask(agent.id);
            }}
            onMouseEnter={handleIconMouseEnter}
            onMouseLeave={handleIconMouseLeave}
          >
            <AgentAvatar
              icon={agent.icon}
              name={agent.title}
              size="xs"
              className="w-full h-full [&_svg]:w-1/2 [&_svg]:h-1/2"
            />
            {hasBadge && !isActive && (
              <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar pointer-events-none" />
            )}
          </SidebarMenuButton>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              onMarkSeen?.();
              navigate({
                to: "/$org/$virtualMcpId",
                params: { org, virtualMcpId: agent.id },
              });
            }}
          >
            <Settings01 size={14} />
            Settings
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              actions.update.mutate({ id: agent.id, data: { pinned: false } });
              if (isActive) {
                navigate({ to: "/$org", params: { org } });
              }
            }}
            className=""
          >
            <X size={14} />
            Unpin
          </ContextMenuItem>
        </ContextMenuContent>

        {buttonRect &&
          createPortal(
            <button
              ref={xRef}
              type="button"
              onMouseLeave={() => setButtonRect(null)}
              onClick={(e) => {
                e.stopPropagation();
                setButtonRect(null);
                actions.update.mutate({
                  id: agent.id,
                  data: { pinned: false },
                });
                navigate({ to: "/$org", params: { org } });
              }}
              className={cn(
                "flex items-center justify-center",
                "bg-sidebar-accent text-muted-foreground",
                "rounded-xl cursor-pointer",
                "animate-in fade-in-0 slide-in-from-right-2",
                "duration-150 [animation-timing-function:cubic-bezier(0.165,0.84,0.44,1)]",
                "hover:text-foreground transition-colors",
              )}
              style={{
                position: "fixed",
                top: buttonRect.top,
                left: buttonRect.left,
                height: buttonRect.height,
                width: xTotalWidth,
                paddingLeft: buttonRect.width,
                zIndex: 50,
                boxShadow:
                  "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 0.5px hsla(0, 0%, 0%, 0.12)",
              }}
            >
              <X size={14} />
            </button>,
            document.body,
          )}
      </SidebarMenuItem>
    </ContextMenu>
  );
}

function AgentGridItem({
  agent,
  onClick,
}: {
  agent: VirtualMCPEntity;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group"
    >
      <AgentAvatar
        icon={agent.icon}
        name={agent.title}
        size="md"
        className="transition-transform group-hover:scale-105"
      />
      <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground line-clamp-2 w-full">
        {agent.title}
      </span>
    </button>
  );
}

function PinAgentPopoverContent({
  onClose,
  onOpenSiteEditorModal,
}: {
  onClose: () => void;
  onOpenSiteEditorModal: () => void;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const actions = useVirtualMCPActions();
  const { org } = useProjectContext();
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP();

  const navigateToNewTask = useCreateTaskAndNavigate();

  const lowerSearch = search.toLowerCase();
  const userAgents = allAgents
    .filter((s) => !isDecopilot(s.id))
    .filter((s) => !search || s.title.toLowerCase().includes(lowerSearch));

  const filteredDefaults = DEFAULT_AGENTS.filter(
    (a) => !search || a.title.toLowerCase().includes(lowerSearch),
  );

  const handleSelect = async (agent: VirtualMCPEntity) => {
    if (!agent.pinned) {
      await actions.update.mutateAsync({
        id: agent.id,
        data: { pinned: true },
      });
    }
    onClose();
    setSearch("");
    navigateToNewTask(agent.id);
  };

  const handleDefaultAgentClick = (agentId: string) => {
    onClose();
    setSearch("");
    if (agentId === SITE_EDITOR_AGENT.id) {
      onOpenSiteEditorModal();
    } else {
      navigateToNewTask(agentId);
    }
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
      <div className="overflow-y-auto flex-1 min-h-0 px-3 pb-3">
        {/* Your Agents section */}
        <div className="px-1 pt-3 pb-2">
          <span className="text-xs font-medium text-muted-foreground">
            Your Agents
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {/* Create new button */}
          <button
            type="button"
            disabled={isCreating}
            onClick={async () => {
              const { id } = await createVirtualMCP();
              onClose();
              navigateToNewTask(id);
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-dashed border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Plus size={18} className="text-muted-foreground" />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Create new
            </span>
          </button>

          {userAgents.map((agent) => (
            <AgentGridItem
              key={agent.id}
              agent={agent}
              onClick={() => handleSelect(agent)}
            />
          ))}
        </div>

        {/* Default Agents section */}
        {filteredDefaults.length > 0 && (
          <>
            <div className="px-1 pt-4 pb-2">
              <span className="text-xs font-medium text-muted-foreground">
                Agents
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {filteredDefaults.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => handleDefaultAgentClick(agent.id)}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <AgentAvatar
                    icon={agent.icon}
                    name={agent.title}
                    size="md"
                    className="transition-transform group-hover:scale-105"
                  />
                  <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground line-clamp-2 w-full">
                    {agent.title}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {userAgents.length === 0 &&
          filteredDefaults.length === 0 &&
          !isCreating && (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              {search ? "No agents found" : "No agents yet"}
            </div>
          )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2.5">
        <Link
          to="/$org/agents"
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

function PinAgentPopover() {
  const [open, setOpen] = useState(false);
  const [siteEditorModalOpen, setSiteEditorModalOpen] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <SidebarMenuItem>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              tooltip="Browse agents"
              className="bg-sidebar-accent hover:bg-sidebar-accent/80"
            >
              <Plus className="!opacity-100" />
            </SidebarMenuButton>
          </PopoverTrigger>
        </SidebarMenuItem>
        <PopoverContent
          className="w-[380px] p-0 overflow-hidden"
          side="right"
          align="start"
        >
          {open && (
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-8">
                  <Skeleton className="h-4 w-24" />
                </div>
              }
            >
              <PinAgentPopoverContent
                onClose={() => setOpen(false)}
                onOpenSiteEditorModal={() => setSiteEditorModalOpen(true)}
              />
            </Suspense>
          )}
        </PopoverContent>
      </Popover>
      <SiteEditorOnboardingModal
        open={siteEditorModalOpen}
        onOpenChange={setSiteEditorModalOpen}
      />
    </>
  );
}

function AgentsSectionContent() {
  const agents = useVirtualMCPs({
    filters: [{ column: "pinned", value: true }],
  });
  const { org } = useProjectContext();
  const { badges, markSeen } = useAgentBadges(agents.map((s) => s.id));

  return (
    <SidebarGroup className="py-0 px-0 mt-2">
      <div className="h-px bg-border mx-2 mb-2" />
      <SidebarGroupContent>
        <SidebarMenu className="gap-2">
          <PinAgentPopover />
          {agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              org={org.slug}
              hasBadge={badges[agent.id]}
              onMarkSeen={() => markSeen(agent.id)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function SidebarAgentsSection() {
  return (
    <Suspense
      fallback={
        <SidebarGroup className="py-0 px-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <div className="flex items-center gap-2 px-2 py-2">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      }
    >
      <AgentsSectionContent />
    </Suspense>
  );
}
