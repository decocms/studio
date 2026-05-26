import { Suspense, useState } from "react";
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
import { Globe02, Plus } from "@untitledui/icons";
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
import {
  HYDROGEN_TEMPLATE,
  SHOPIFY_HYDROGEN_ICON,
  WEBSITE_TEMPLATE,
  useCreateAgentFromTemplate,
} from "@/web/hooks/use-create-website-agent";
import { track } from "@/web/lib/posthog-client";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AgentAvatar } from "@/web/components/agent-icon";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker.tsx";
import { SelfHealingRepoFlow } from "@/web/components/self-healing-repo/self-healing-repo-flow.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { StudioPackRecruitModal } from "@/web/components/home/studio-pack-recruit-modal.tsx";
import { LeanCanvasRecruitModal } from "@/web/components/home/lean-canvas-recruit-modal.tsx";
import { AiImageRecruitModal } from "@/web/components/home/ai-image-recruit-modal.tsx";
import { AiResearchRecruitModal } from "@/web/components/home/ai-research-recruit-modal.tsx";
import { QaAgentRecruitModal } from "@/web/components/home/qa-agent-recruit-modal.tsx";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";

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
  onOpenQaAgentModal,
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
  onOpenQaAgentModal: () => void;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const { org } = useProjectContext();
  const serverPinnedIds = allAgents.filter((a) => a.pinned).map((a) => a.id);
  const { pin, isPinned } = usePinnedAgents(org.id, serverPinnedIds);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const { createFromTemplate, isCreating: isCreatingFromTemplate } =
    useCreateAgentFromTemplate();
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

  const qaAgentTemplate = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "qa-agent",
  );
  const existingQaAgent = qaAgentTemplate
    ? allAgents.find(
        (a) =>
          (a as { metadata?: { type?: string } }).metadata?.type ===
          qaAgentTemplate.id,
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
    } else if (templateId === "qa-agent") {
      if (existingQaAgent) {
        navigateToAgent(existingQaAgent.id);
      } else {
        onOpenQaAgentModal();
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

          <button
            type="button"
            disabled={isCreatingFromTemplate}
            onClick={async () => {
              track("agent_create_clicked", {
                source: "browse_popover",
                method: "website",
              });
              await createFromTemplate(WEBSITE_TEMPLATE);
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Globe02 className="size-5 text-muted-foreground" />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Start Website
            </span>
          </button>

          <button
            type="button"
            disabled={isCreatingFromTemplate}
            onClick={async () => {
              track("agent_create_clicked", {
                source: "browse_popover",
                method: "hydrogen",
              });
              await createFromTemplate(HYDROGEN_TEMPLATE);
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <img
                src={SHOPIFY_HYDROGEN_ICON}
                alt=""
                className="size-5 object-contain"
              />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Shopify Headless Store
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

function PinAgentPopover({ compact = false }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [selfHealingOpen, setSelfHealingOpen] = useState(false);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const [leanCanvasModalOpen, setLeanCanvasModalOpen] = useState(false);
  const [studioPackModalOpen, setStudioPackModalOpen] = useState(false);
  const [aiImageModalOpen, setAiImageModalOpen] = useState(false);
  const [aiResearchModalOpen, setAiResearchModalOpen] = useState(false);
  const [qaAgentModalOpen, setQaAgentModalOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const compactTriggerClass =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors";

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
        onOpenQaAgentModal={() => setQaAgentModalOpen(true)}
      />
    </Suspense>
  );

  return (
    <>
      {isMobile ? (
        <>
          {compact ? (
            <button
              type="button"
              aria-label="Browse agents"
              onClick={() => {
                track("agent_browser_opened", { surface: "mobile_drawer" });
                setOpen(true);
              }}
              className={compactTriggerClass}
            >
              <Plus className="size-4" />
            </button>
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Browse agents"
                onClick={() => {
                  track("agent_browser_opened", { surface: "mobile_drawer" });
                  setOpen(true);
                }}
              >
                <Plus />
                <span>New</span>
              </SidebarMenuButton>
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
          {compact ? (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Browse agents"
                className={compactTriggerClass}
              >
                <Plus className="size-4" />
              </button>
            </PopoverTrigger>
          ) : (
            <SidebarMenuItem>
              <PopoverTrigger asChild>
                <SidebarMenuButton tooltip="Browse agents">
                  <Plus />
                  <span>New</span>
                </SidebarMenuButton>
              </PopoverTrigger>
            </SidebarMenuItem>
          )}
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
      <QaAgentRecruitModal
        open={qaAgentModalOpen}
        onOpenChange={setQaAgentModalOpen}
      />
    </>
  );
}

/**
 * BrowseAgentsButton — the "+" sidebar button that opens the Browse Agents
 * popover (desktop) / drawer (mobile). Re-exported from this module so other
 * sidebar surfaces can mount the trigger without depending on the full agents
 * list. Same component as PinAgentPopover.
 */
export { PinAgentPopover as BrowseAgentsButton };
