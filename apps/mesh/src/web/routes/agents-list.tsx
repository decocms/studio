import { useState } from "react";
import { CreateAgentDropdownContent } from "@/web/components/create-agent-dropdown";
import {
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  useVirtualMCPsLastUsed,
} from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import { ProjectCard } from "@/web/components/project-card";
import { useCapability } from "@/web/hooks/use-capability";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import {
  HYDROGEN_TEMPLATE,
  WEBSITE_TEMPLATE,
  useCreateAgentFromTemplate,
} from "@/web/hooks/use-create-website-agent";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
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
  const [search, setSearch] = useState("");
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const { createFromTemplate, isCreating: isCreatingFromTemplate } =
    useCreateAgentFromTemplate();
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const { granted: canManageAgents } = useCapability("agents:manage");

  const lowerSearch = search.toLowerCase();

  // Filter out org-admin and apply search
  const filteredAgents = agents.filter(
    (s) =>
      s.id !== org.id &&
      (s.title.toLowerCase().includes(lowerSearch) ||
        s.description?.toLowerCase().includes(lowerSearch)),
  );

  const { data: lastUsedMap } = useVirtualMCPsLastUsed(
    filteredAgents.map((a) => a.id),
  );

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
              {canManageAgents && (
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
                    onCreateWebsite={() => {
                      track("agent_create_clicked", {
                        source: "agents_list",
                        method: "website",
                      });
                      createFromTemplate(WEBSITE_TEMPLATE);
                    }}
                    onCreateHydrogenStore={() => {
                      track("agent_create_clicked", {
                        source: "agents_list",
                        method: "hydrogen",
                      });
                      createFromTemplate(HYDROGEN_TEMPLATE);
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
                    isCreating={isCreating || isCreatingFromTemplate}
                    align="end"
                  />
                </DropdownMenu>
              )}
            </div>
          </div>

          {filteredAgents.length === 0 && (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={
                  <FolderClosed size={48} className="text-muted-foreground" />
                }
                title={search ? "No agents found" : "No agents yet"}
                description={
                  search
                    ? `No agents match "${search}"`
                    : canManageAgents
                      ? "Create an agent to get started."
                      : "Ask an organization admin to create one."
                }
                actions={
                  !search &&
                  canManageAgents && (
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
                        onCreateWebsite={() => {
                          track("agent_create_clicked", {
                            source: "agents_list_empty",
                            method: "website",
                          });
                          createFromTemplate(WEBSITE_TEMPLATE);
                        }}
                        onCreateHydrogenStore={() => {
                          track("agent_create_clicked", {
                            source: "agents_list_empty",
                            method: "hydrogen",
                          });
                          createFromTemplate(HYDROGEN_TEMPLATE);
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
                        isCreating={isCreating || isCreatingFromTemplate}
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
                    lastUsedAt={lastUsedMap?.get(agent.id)?.last_used_at}
                    onDeleteClick={
                      canManageAgents
                        ? () =>
                            setDeleteTarget({
                              id: agent.id,
                              title: agent.title,
                            })
                        : undefined
                    }
                  />
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
