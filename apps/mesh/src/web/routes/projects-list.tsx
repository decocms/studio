import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useProjects } from "@/web/hooks/use-projects";
import { Page } from "@/web/components/page";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { ProjectCard } from "@/web/components/project-card";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { CreateProjectDialog } from "@/web/components/create-project-dialog";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog";
import { usePublicConfig } from "@/web/hooks/use-public-config";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { FolderClosed, Plus } from "@untitledui/icons";

function ImportFromDecoButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        size="sm"
        className="h-7 px-3 rounded-lg text-sm font-medium"
      >
        Import from deco.cx
      </Button>
      <ImportFromDecoDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export default function ProjectsListPage() {
  const { org } = useProjectContext();
  const projects = useProjects();
  const { enableDecoImport } = usePublicConfig();
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const navigate = useNavigate();

  // Filter out org-admin and apply search
  const userProjects = projects.filter(
    (p) =>
      p.id !== org.id &&
      (p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.description?.toLowerCase().includes(search.toLowerCase())),
  );

  const handleSettingsClick = (projectId: string) => {
    navigate({
      to: "/$org/projects/$virtualMcpId/settings/general",
      params: {
        org: org.slug,
        virtualMcpId: projectId,
      },
    });
  };

  const handleCreateProject = () => {
    setCreateDialogOpen(true);
  };

  return (
    <Page>
      {/* Page Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Projects</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          {enableDecoImport && <ImportFromDecoButton />}
          <Button onClick={handleCreateProject} size="sm">
            <Plus size={14} />
            Create Project
          </Button>
        </Page.Header.Right>
      </Page.Header>

      {/* Search Bar */}
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search for a project..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      {/* Content */}
      <Page.Content className="@container">
        {/* Empty State */}
        {userProjects.length === 0 && (
          <div className="flex items-center h-full">
            <EmptyState
              image={
                <FolderClosed size={48} className="text-muted-foreground" />
              }
              title={search ? "No projects found" : "No projects yet"}
              description={
                search
                  ? `No projects match "${search}"`
                  : "Create a project to get started."
              }
              actions={
                !search && (
                  <Button size="sm" onClick={handleCreateProject}>
                    <Plus size={14} />
                    Create Project
                  </Button>
                )
              }
            />
          </div>
        )}

        {/* Card Grid */}
        {userProjects.length > 0 && (
          <div className="p-5">
            <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
              {userProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onSettingsClick={() => handleSettingsClick(project.id)}
                />
              ))}
            </div>
          </div>
        )}
      </Page.Content>

      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </Page>
  );
}
