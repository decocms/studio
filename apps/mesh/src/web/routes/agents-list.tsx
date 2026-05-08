import { useState } from "react";
import { CreateAgentDropdownContent } from "@/web/components/create-agent-dropdown";
import {
  WELL_KNOWN_AGENT_TEMPLATES,
  isStudioPackAgent,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import { ProjectCard } from "@/web/components/project-card";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AgentAvatar } from "@/web/components/agent-icon";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { StudioPackRecruitModal } from "@/web/components/home/studio-pack-recruit-modal.tsx";
import { LeanCanvasRecruitModal } from "@/web/components/home/lean-canvas-recruit-modal.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { FolderClosed, Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker.tsx";
import { track } from "@/web/lib/posthog-client";

export default function AgentsListPage() {
  const { org } = useProjectContext();
  const agents = useVirtualMCPs();
  const actions = useVirtualMCPActions();
  const navigateToAgent = useNavigateToAgent();
  const [search, setSearch] = useState("");
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const [studioPackModalOpen, setStudioPackModalOpen] = useState(false);
  const [leanCanvasModalOpen, setLeanCanvasModalOpen] = useState(false);

  const lowerSearch = search.toLowerCase();

  // Filter out org-admin and apply search
  const filteredAgents = agents.filter(
    (s) =>
      s.id !== org.id &&
      (s.title.toLowerCase().includes(lowerSearch) ||
        s.description?.toLowerCase().includes(lowerSearch)),
  );

  // Check if studio pack is already installed
  const studioPackInstalled = agents.some((a) => isStudioPackAgent(a.id));

  // Filter templates by search only (always render all templates)
  // Hide studio-pack template if already installed
  const filteredTemplates = WELL_KNOWN_AGENT_TEMPLATES.filter(
    (t) =>
      (!search || t.title.toLowerCase().includes(lowerSearch)) &&
      !(t.id === "studio-pack" && studioPackInstalled),
  );

  // Find existing recruited Site Diagnostics agent
  const existingDiagnostics = agents.find(
    (a) =>
      (a as { metadata?: { type?: string } }).metadata?.type ===
      "site-diagnostics",
  );

  // Find existing recruited Lean Canvas agent
  const existingLeanCanvas = agents.find(
    (a) =>
      (a as { metadata?: { type?: string } }).metadata?.type === "lean-canvas",
  );

  const handleTemplateClick = (templateId: string) => {
    track("agents_list_template_clicked", { template_id: templateId });
    if (templateId === "site-editor") {
      setImportDecoOpen(true);
    } else if (templateId === "site-diagnostics") {
      if (existingDiagnostics) {
        navigateToAgent(existingDiagnostics.id);
      } else {
        setDiagnosticsModalOpen(true);
      }
    } else if (templateId === "lean-canvas") {
      if (existingLeanCanvas) {
        navigateToAgent(existingLeanCanvas.id);
      } else {
        setLeanCanvasModalOpen(true);
      }
    } else if (templateId === "studio-pack") {
      setStudioPackModalOpen(true);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { id, title } = deleteTarget;
    setDeleteTarget(null);
    try {
      await actions.delete.mutateAsync(id);
      track("agent_deleted", { agent_id: id, source: "agents_list" });
      toast.success(`Deleted "${title}"`);
    } catch {
      // Error toast handled by mutation
    }
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Agents</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search for an agent..."
                className="w-full md:w-[375px]"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("");
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus size={14} />
                    Create Agent
                  </Button>
                </DropdownMenuTrigger>
                <CreateAgentDropdownContent
                  onCreateFromScratch={() => {
                    track("agent_create_clicked", {
                      source: "agents_list",
                      method: "scratch",
                    });
                    createVirtualMCP();
                  }}
                  onImportGitHub={() => {
                    track("agent_create_clicked", {
                      source: "agents_list",
                      method: "github",
                    });
                    setGithubPickerOpen(true);
                  }}
                  onImportDeco={() => {
                    track("agent_create_clicked", {
                      source: "agents_list",
                      method: "deco",
                    });
                    setImportDecoOpen(true);
                  }}
                  isCreating={isCreating}
                  align="end"
                />
              </DropdownMenu>
            </div>
          </div>

          {filteredAgents.length === 0 && filteredTemplates.length === 0 && (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={
                  <FolderClosed size={48} className="text-muted-foreground" />
                }
                title={search ? "No agents found" : "No agents yet"}
                description={
                  search
                    ? `No agents match "${search}"`
                    : "Create an agent to get started."
                }
                actions={
                  !search && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm">
                          <Plus size={14} />
                          Create Agent
                        </Button>
                      </DropdownMenuTrigger>
                      <CreateAgentDropdownContent
                        onCreateFromScratch={() => {
                          track("agent_create_clicked", {
                            source: "agents_list_empty",
                            method: "scratch",
                          });
                          createVirtualMCP();
                        }}
                        onImportGitHub={() => {
                          track("agent_create_clicked", {
                            source: "agents_list_empty",
                            method: "github",
                          });
                          setGithubPickerOpen(true);
                        }}
                        onImportDeco={() => {
                          track("agent_create_clicked", {
                            source: "agents_list_empty",
                            method: "deco",
                          });
                          setImportDecoOpen(true);
                        }}
                        isCreating={isCreating}
                        align="center"
                        showBetaBadge
                      />
                    </DropdownMenu>
                  )
                }
              />
            </div>
          )}

          {filteredAgents.length > 0 && (
            <div className="mt-6 @container">
              <h3 className="text-sm font-medium text-muted-foreground mb-3">
                Agents
              </h3>
              <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
                {filteredAgents.map((agent) => (
                  <ProjectCard
                    key={agent.id}
                    project={agent}
                    onDeleteClick={() =>
                      setDeleteTarget({
                        id: agent.id,
                        title: agent.title,
                      })
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {filteredTemplates.length > 0 && (
            <div className="mt-6 @container">
              <h3 className="text-sm font-medium text-muted-foreground mb-3">
                Agent Templates
              </h3>
              <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
                {filteredTemplates.map((template) => (
                  <Card
                    key={template.id}
                    className="relative transition-colors group overflow-hidden flex flex-col h-full hover:bg-muted/50 cursor-pointer"
                    onClick={() => handleTemplateClick(template.id)}
                  >
                    <div className="flex flex-col flex-1">
                      <div className="flex flex-col gap-3 p-4.5">
                        <AgentAvatar
                          icon={template.icon}
                          name={template.title}
                          size="sm"
                          className="shrink-0 shadow-sm"
                        />
                        <div className="flex flex-col gap-1">
                          <h3 className="text-sm font-medium text-foreground truncate">
                            {template.title}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            Click to set up
                          </p>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </Page.Body>
      </Page.Content>

      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={setGithubPickerOpen}
      />
      <ImportFromDecoDialog
        open={importDecoOpen}
        onOpenChange={setImportDecoOpen}
      />
      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
      />
      <LeanCanvasRecruitModal
        open={leanCanvasModalOpen}
        onOpenChange={setLeanCanvasModalOpen}
        existingAgent={existingLeanCanvas}
      />
      <StudioPackRecruitModal
        open={studioPackModalOpen}
        onOpenChange={setStudioPackModalOpen}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
