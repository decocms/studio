import { Suspense, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
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
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { usePinnedAgents } from "@/web/hooks/use-pinned-agents";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { useCreateTaskAndNavigate } from "@/web/hooks/use-create-task-and-navigate";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import { SiteEditorOnboardingModal } from "@/web/components/home/site-editor-onboarding-modal.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { useAgentBadges } from "@/web/hooks/use-agent-badges";

const SITE_EDITOR_AGENT = {
  id: "site-editor",
  title: "Site Editor",
  icon: "icon://Globe01?color=violet",
} as const;

const SITE_DIAGNOSTICS_AGENT = {
  id: "site-diagnostics",
  title: "Site Diagnostics",
  icon: "icon://SearchRefraction?color=cyan",
} as const;

const DEFAULT_AGENTS = [SITE_EDITOR_AGENT, SITE_DIAGNOSTICS_AGENT];

function AgentListItem({
  agent,
  org,
  hasBadge,
  onMarkSeen,
  onUnpin,
  isDragging,
}: {
  agent: VirtualMCPEntity;
  org: string;
  hasBadge?: boolean;
  onMarkSeen?: () => void;
  onUnpin: () => void;
  isDragging?: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigateToNewTask = useCreateTaskAndNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = pathname.startsWith(`/${org}/${agent.id}`);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const xRef = useRef<HTMLButtonElement>(null);
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  isDraggingRef.current = !!isDragging;

  if (isDragging && (buttonRect || showTimeoutRef.current)) {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (buttonRect) setButtonRect(null);
  }

  const handleIconMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDraggingRef.current) return;
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    showTimeoutRef.current = setTimeout(() => {
      if (isDraggingRef.current) return;
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
              if (isMobile) setOpenMobile(false);
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
              onUnpin();
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
                onUnpin();
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

function SortableAgentListItem(props: {
  agent: VirtualMCPEntity;
  org: string;
  hasBadge?: boolean;
  onMarkSeen?: () => void;
  onUnpin: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.agent.id });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="w-full"
    >
      <AgentListItem {...props} isDragging={isDragging} />
    </div>
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
  onOpenDiagnosticsModal,
}: {
  onClose: () => void;
  onOpenSiteEditorModal: () => void;
  onOpenDiagnosticsModal: () => void;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const { org } = useProjectContext();
  const serverPinnedIds = allAgents.filter((a) => a.pinned).map((a) => a.id);
  const { pin, isPinned } = usePinnedAgents(org.id, serverPinnedIds);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });

  const navigateToNewTask = useCreateTaskAndNavigate();

  const lowerSearch = search.toLowerCase();
  const userAgents = allAgents
    .filter((s) => !isDecopilot(s.id))
    .filter((s) => !search || s.title.toLowerCase().includes(lowerSearch));

  // Hide default agents that have already been recruited as real agents
  const hasDiagnostics = allAgents.some(
    (a) =>
      (a as { metadata?: { type?: string } }).metadata?.type ===
      "site-diagnostics",
  );
  const filteredDefaults = DEFAULT_AGENTS.filter(
    (a) => !search || a.title.toLowerCase().includes(lowerSearch),
  ).filter((a) => !(a.id === SITE_DIAGNOSTICS_AGENT.id && hasDiagnostics));

  const handleSelect = (agent: VirtualMCPEntity) => {
    if (!isPinned(agent.id)) {
      pin(agent.id);
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
    } else if (agentId === SITE_DIAGNOSTICS_AGENT.id) {
      onOpenDiagnosticsModal();
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
        {/* Agents section */}
        <div className="px-1 pt-3 pb-2">
          <span className="text-xs font-medium text-muted-foreground">
            Agents
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {/* Create new button */}
          <button
            type="button"
            disabled={isCreating}
            onClick={async () => {
              await createVirtualMCP();
              onClose();
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

        {/* Agent templates section */}
        {filteredDefaults.length > 0 && (
          <>
            <div className="px-1 pt-4 pb-2">
              <span className="text-xs font-medium text-muted-foreground">
                Agent templates
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
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

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
        onOpenSiteEditorModal={() => setSiteEditorModalOpen(true)}
        onOpenDiagnosticsModal={() => setDiagnosticsModalOpen(true)}
      />
    </Suspense>
  );

  return (
    <>
      {isMobile ? (
        <>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Browse agents"
              className="bg-muted/75 hover:bg-sidebar-accent"
              onClick={() => setOpen(true)}
            >
              <Plus className="!opacity-100" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <Drawer open={open} onOpenChange={setOpen} direction="bottom">
            <DrawerContent className="max-h-[85dvh] p-0">
              <DrawerTitle className="sr-only">Browse agents</DrawerTitle>
              {popoverContent}
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <SidebarMenuItem>
            <PopoverTrigger asChild>
              <SidebarMenuButton
                tooltip="Browse agents"
                className="bg-muted/75 hover:bg-sidebar-accent"
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
            {popoverContent}
          </PopoverContent>
        </Popover>
      )}
      <SiteEditorOnboardingModal
        open={siteEditorModalOpen}
        onOpenChange={setSiteEditorModalOpen}
      />
      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
      />
    </>
  );
}

function AgentsSectionContent() {
  const allAgents = useVirtualMCPs();
  const { org } = useProjectContext();
  const serverPinnedIds = allAgents.filter((a) => a.pinned).map((a) => a.id);
  const { pinnedIds, unpin, reorder } = usePinnedAgents(
    org.id,
    serverPinnedIds,
  );

  const agentMap = new Map(allAgents.map((a) => [a.id, a]));
  const pinnedAgents = pinnedIds
    .map((id) => agentMap.get(id))
    .filter((a): a is VirtualMCPEntity => !!a);

  const { badges, markSeen } = useAgentBadges(pinnedAgents.map((s) => s.id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = pinnedIds.indexOf(active.id as string);
    const newIndex = pinnedIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;

    reorder(arrayMove([...pinnedIds], oldIndex, newIndex));
  };

  return (
    <SidebarGroup className="py-0 px-0 mt-2 flex-1 min-h-0">
      <div className="h-px bg-border mx-2 mb-2" />
      <SidebarGroupContent className="flex flex-1 min-h-0 flex-col">
        <SidebarMenu className="gap-2 flex-1 min-h-0 overflow-y-auto pr-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <PinAgentPopover />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={pinnedIds}
              strategy={verticalListSortingStrategy}
            >
              {pinnedAgents.map((agent) => (
                <SortableAgentListItem
                  key={agent.id}
                  agent={agent}
                  org={org.slug}
                  hasBadge={badges[agent.id]}
                  onMarkSeen={() => markSeen(agent.id)}
                  onUnpin={() => unpin(agent.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
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
