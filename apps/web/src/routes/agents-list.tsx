import { useState } from "react";
import { CreateAgentDropdownContent } from "@/components/create-agent-dropdown";
import {
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  useVirtualMCPsLastUsed,
} from "@/sdk";
import { Main } from "@/components/main";
import { ProjectCard } from "@/components/project-card";
import { useCapability } from "@/hooks/use-capability";
import { useIsDecoStaff } from "@/hooks/use-organization-settings";
import { EmptyState } from "@/components/empty-state.tsx";
import { useCreateVirtualMCP } from "@/hooks/use-create-virtual-mcp";
import { ImportFromDecoDialog } from "@/components/import-from-deco-dialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { FolderClosed, Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { GitHubRepoPicker } from "@/components/github-repo-picker.tsx";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";

export default function AgentsListPage() {
  const t = useT();
  const { org } = useProjectContext();
  const [search, setSearch] = useState("");
  const searchTerm = useDebouncedValue(search, 300);
  const agents = useVirtualMCPs({ searchTerm });
  const actions = useVirtualMCPActions();
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const { granted: canManageAgents } = useCapability("agents:manage");
  const showDecoImport = useIsDecoStaff();

  // Search is server-side via searchTerm; only the org-admin exclusion stays here.
  const filteredAgents = agents.filter((s) => s.id !== org.id);

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
      toast.success(t("routes.agentsList.deletedAgent", { title }));
    } catch {
      // Error toast handled by mutation
    }
  };

  const searchInput =
    search || filteredAgents.length > 0 ? (
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("routes.agentsList.searchPlaceholder")}
        className="w-[clamp(7rem,35cqw,23.4375rem)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    ) : null;

  const createButton = canManageAgents ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" aria-label={t("routes.agentsList.createAgent")}>
          <Plus size={14} />
          <span className="@max-sm/main-topbar:hidden">
            {t("routes.agentsList.createAgent")}
          </span>
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
        showDecoImport={showDecoImport}
      />
    </DropdownMenu>
  ) : null;

  return (
    <>
      {searchInput && (
        <Main.Topbar.Center.Portal>
          <div
            data-responsive-focus-group="projects-search"
            className="hidden md:block"
          >
            {searchInput}
          </div>
        </Main.Topbar.Center.Portal>
      )}
      {searchInput && (
        <Main.Toolbar.Portal visibility="compact">
          <div
            data-responsive-focus-group="projects-search"
            className="w-full md:hidden [&>*]:w-full"
          >
            {searchInput}
          </div>
        </Main.Toolbar.Portal>
      )}
      {createButton && (
        <Main.Topbar.Right.Portal>{createButton}</Main.Topbar.Right.Portal>
      )}

      <div className="h-full overflow-y-auto">
        <Main.Container width="wide">
          <Main.Stack>
            {filteredAgents.length === 0 && (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={
                    <FolderClosed size={48} className="text-muted-foreground" />
                  }
                  title={
                    search
                      ? t("routes.agentsList.noAgentsFound")
                      : t("routes.agentsList.noAgentsYet")
                  }
                  description={
                    search
                      ? t("routes.agentsList.noAgentsMatchSearch", { search })
                      : canManageAgents
                        ? t("routes.agentsList.createAgentToGetStarted")
                        : t("routes.agentsList.askAdminToCreate")
                  }
                  actions={
                    !search &&
                    canManageAgents && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm">
                            <Plus size={14} />
                            {t("routes.agentsList.createAgent")}
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
                          showDecoImport={showDecoImport}
                        />
                      </DropdownMenu>
                    )
                  }
                />
              </div>
            )}

            {filteredAgents.length > 0 && (
              <Main.Section className="@container">
                <Main.Section.Title className="text-muted-foreground">
                  {t("routes.agentsList.agentsHeading")}
                </Main.Section.Title>
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
              </Main.Section>
            )}
          </Main.Stack>
        </Main.Container>
      </div>

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
            <AlertDialogTitle>
              {t("routes.agentsList.deleteAgentTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("routes.agentsList.deleteAgentDescription")}{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("routes.agentsList.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("routes.agentsList.deleteButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
