import { Suspense, useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
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
import { Plus, Settings02, X } from "@untitledui/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import {
  isDecopilot,
  isStudioPackAgent,
  WELL_KNOWN_AGENT_TEMPLATES,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { usePinnedAgents } from "@/web/hooks/use-pinned-agents";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { track } from "@/web/lib/posthog-client";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AgentAvatar } from "@/web/components/agent-icon";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker.tsx";
import { SelfHealingRepoFlow } from "@/web/components/self-healing-repo/self-healing-repo-flow.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { StudioPackRecruitModal } from "@/web/components/home/studio-pack-recruit-modal.tsx";
import { LeanCanvasRecruitModal } from "@/web/components/home/lean-canvas-recruit-modal.tsx";
import { AiImageRecruitModal } from "@/web/components/home/ai-image-recruit-modal.tsx";
import { AiResearchRecruitModal } from "@/web/components/home/ai-research-recruit-modal.tsx";
import { useTaskActions } from "@/web/hooks/use-tasks";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { useNavigateToAgentThread } from "@/web/hooks/use-navigate-to-agent-thread";

/**
 * Hook for "spawn task on this vMCP" buttons (used by the browse-agents
 * popover). When the user clicks a vMCP that matches the URL's current
 * virtualmcpid, the active task's branch is carried into the new thread
 * so the new task lands on the same warm sandbox. When the clicked vMCP
 * differs, no branch is passed and the server picks the most-recently-
 * touched vmMap entry for that vMCP.
 *
 * The sidebar pinned-agent click uses `useNavigateToAgentThread` instead,
 * which resumes the user's last thread when one exists.
 */
function useNavigateToNewTaskWithBranchCarry(orgSlug: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taskActions = useTaskActions();
  const { locator } = useProjectContext();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };

  return async (clickedVirtualMcpId: string) => {
    const taskId = crypto.randomUUID();
    const carryBranch =
      clickedVirtualMcpId === search.virtualmcpid
        ? readCachedTaskBranch(queryClient, locator, params.taskId ?? "")
        : null;
    try {
      await taskActions.create.mutateAsync({
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

function AgentListItem({
  agent,
  org,
  onUnpin,
  isDragging,
}: {
  agent: VirtualMCPEntity;
  org: string;
  onUnpin: () => void;
  isDragging?: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigateToAgentThread = useNavigateToAgentThread(org);
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
            onClick={async () => {
              if (isMobile) setOpenMobile(false);
              const { resumed } = await navigateToAgentThread(agent.id);
              track("sidebar_agent_pin_clicked", {
                agent_id: agent.id,
                agent_title: agent.title,
                resumed,
              });
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
          </SidebarMenuButton>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              const taskId = crypto.randomUUID();
              navigate({
                to: "/$org/$taskId",
                params: { org, taskId },
                search: { virtualmcpid: agent.id },
              });
            }}
          >
            <Settings02 size={14} />
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
      tabIndex={-1}
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
  onOpenImportDeco,
  onOpenGithubImport,
  onOpenSelfHealing,
  onOpenDiagnosticsModal,
  onOpenLeanCanvasModal,
  onOpenStudioPackModal,
  onOpenAiImageModal,
  onOpenAiResearchModal,
}: {
  onClose: () => void;
  onOpenImportDeco: () => void;
  onOpenGithubImport: () => void;
  onOpenSelfHealing: () => void;
  onOpenDiagnosticsModal: () => void;
  onOpenLeanCanvasModal: () => void;
  onOpenStudioPackModal: () => void;
  onOpenAiImageModal: () => void;
  onOpenAiResearchModal: () => void;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const { org } = useProjectContext();
  const serverPinnedIds = allAgents.filter((a) => a.pinned).map((a) => a.id);
  const { pin, isPinned } = usePinnedAgents(org.id, serverPinnedIds);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const [preferences] = usePreferences();

  const navigateToNewTask = useNavigateToNewTaskWithBranchCarry(org.slug);
  const navigateToAgent = useNavigateToAgent();

  const lowerSearch = search.toLowerCase();
  const userAgents = allAgents
    .filter((s) => !isDecopilot(s.id))
    .filter((s) => !search || s.title.toLowerCase().includes(lowerSearch));

  const studioPackInstalled = allAgents.some((a) => isStudioPackAgent(a.id));
  const filteredTemplates = WELL_KNOWN_AGENT_TEMPLATES.filter(
    (t) =>
      (!search || t.title.toLowerCase().includes(lowerSearch)) &&
      !(t.id === "studio-pack" && studioPackInstalled) &&
      !(
        t.id === "self-healing-storefront" && !preferences.experimental_vibecode
      ),
  );

  // Find existing recruited Site Diagnostics agent
  const siteDiagnosticsTemplate = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "site-diagnostics",
  );
  const existingDiagnostics = siteDiagnosticsTemplate
    ? allAgents.find(
        (a) =>
          (a as { metadata?: { type?: string } }).metadata?.type ===
          siteDiagnosticsTemplate.id,
      )
    : undefined;

  // Find existing recruited Lean Canvas agent
  const leanCanvasTemplate = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "lean-canvas",
  );
  const existingLeanCanvas = leanCanvasTemplate
    ? allAgents.find(
        (a) =>
          (a as { metadata?: { type?: string } }).metadata?.type ===
          leanCanvasTemplate.id,
      )
    : undefined;

  const aiImageTemplate = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "ai-image",
  );
  const existingAiImage = aiImageTemplate
    ? allAgents.find(
        (a) =>
          (a as { metadata?: { type?: string } }).metadata?.type ===
          aiImageTemplate.id,
      )
    : undefined;

  const aiResearchTemplate = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "ai-research",
  );
  const existingAiResearch = aiResearchTemplate
    ? allAgents.find(
        (a) =>
          (a as { metadata?: { type?: string } }).metadata?.type ===
          aiResearchTemplate.id,
      )
    : undefined;

  const handleSelect = (agent: VirtualMCPEntity) => {
    if (!isPinned(agent.id)) {
      pin(agent.id);
    }
    onClose();
    setSearch("");
    navigateToNewTask(agent.id);
  };

  const handleTemplateClick = (templateId: string) => {
    onClose();
    setSearch("");
    if (templateId === "self-healing-storefront") {
      onOpenSelfHealing();
    } else if (templateId === "site-editor") {
      onOpenImportDeco();
    } else if (templateId === "site-diagnostics") {
      if (existingDiagnostics) {
        navigateToAgent(existingDiagnostics.id);
      } else {
        onOpenDiagnosticsModal();
      }
    } else if (templateId === "lean-canvas") {
      if (existingLeanCanvas) {
        navigateToAgent(existingLeanCanvas.id);
      } else {
        onOpenLeanCanvasModal();
      }
    } else if (templateId === "ai-image") {
      if (existingAiImage) {
        navigateToAgent(existingAiImage.id);
      } else {
        onOpenAiImageModal();
      }
    } else if (templateId === "ai-research") {
      if (existingAiResearch) {
        navigateToAgent(existingAiResearch.id);
      } else {
        onOpenAiResearchModal();
      }
    } else if (templateId === "studio-pack") {
      onOpenStudioPackModal();
    } else {
      navigateToNewTask(templateId);
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
              track("agent_create_new_clicked", { source: "browse_popover" });
              await createVirtualMCP();
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-dashed border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Plus size={16} className="text-muted-foreground" />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Create new
            </span>
          </button>

          {preferences.experimental_vibecode && (
            <button
              type="button"
              onClick={() => {
                track("agent_import_clicked", { source: "github" });
                onOpenGithubImport();
                onClose();
              }}
              className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group"
            >
              <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
                <GitHubIcon className="size-5 text-muted-foreground" />
              </div>
              <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
                Import GitHub
              </span>
            </button>
          )}

          {userAgents.map((agent) => (
            <AgentGridItem
              key={agent.id}
              agent={agent}
              onClick={() => handleSelect(agent)}
            />
          ))}
        </div>

        {/* Agent templates section */}
        {filteredTemplates.length > 0 && (
          <>
            <div className="px-1 pt-4 pb-2">
              <span className="text-xs font-medium text-muted-foreground">
                Agent templates
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {filteredTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => {
                    track("agent_template_clicked", {
                      template_id: template.id,
                      template_title: template.title,
                    });
                    handleTemplateClick(template.id);
                  }}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <AgentAvatar
                    icon={template.icon}
                    name={template.title}
                    size="md"
                    className="transition-transform group-hover:scale-105"
                  />
                  <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground line-clamp-2 w-full">
                    {template.title}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {userAgents.length === 0 &&
          filteredTemplates.length === 0 &&
          !isCreating && (
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

function PinAgentPopover() {
  const [open, setOpen] = useState(false);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [selfHealingOpen, setSelfHealingOpen] = useState(false);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const [leanCanvasModalOpen, setLeanCanvasModalOpen] = useState(false);
  const [studioPackModalOpen, setStudioPackModalOpen] = useState(false);
  const [aiImageModalOpen, setAiImageModalOpen] = useState(false);
  const [aiResearchModalOpen, setAiResearchModalOpen] = useState(false);
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
        onOpenImportDeco={() => setImportDecoOpen(true)}
        onOpenGithubImport={() => {
          setGithubPickerOpen(true);
          handleClose();
        }}
        onOpenSelfHealing={() => {
          setSelfHealingOpen(true);
          handleClose();
        }}
        onOpenDiagnosticsModal={() => setDiagnosticsModalOpen(true)}
        onOpenLeanCanvasModal={() => setLeanCanvasModalOpen(true)}
        onOpenStudioPackModal={() => setStudioPackModalOpen(true)}
        onOpenAiImageModal={() => setAiImageModalOpen(true)}
        onOpenAiResearchModal={() => setAiResearchModalOpen(true)}
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
              onClick={() => {
                track("agent_browser_opened", { surface: "mobile_drawer" });
                setOpen(true);
              }}
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
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next && !open) {
              track("agent_browser_opened", { surface: "desktop_popover" });
            }
            setOpen(next);
          }}
        >
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
      <ImportFromDecoDialog
        open={importDecoOpen}
        onOpenChange={setImportDecoOpen}
      />
      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={setGithubPickerOpen}
      />
      <SelfHealingRepoFlow
        open={selfHealingOpen}
        onOpenChange={setSelfHealingOpen}
      />
      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
      />
      <LeanCanvasRecruitModal
        open={leanCanvasModalOpen}
        onOpenChange={setLeanCanvasModalOpen}
      />
      <StudioPackRecruitModal
        open={studioPackModalOpen}
        onOpenChange={setStudioPackModalOpen}
      />
      <AiImageRecruitModal
        open={aiImageModalOpen}
        onOpenChange={setAiImageModalOpen}
      />
      <AiResearchRecruitModal
        open={aiResearchModalOpen}
        onOpenChange={setAiResearchModalOpen}
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
      {/* NOTE: Do not add horizontal padding (px-*) here — it makes pinned agent icons smaller than the home button. */}
      <SidebarGroupContent className="flex flex-1 min-h-0 flex-col overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <SidebarMenu className="gap-2">
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
