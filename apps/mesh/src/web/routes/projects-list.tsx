import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { useProjects } from "@/web/hooks/use-project";
import { Page } from "@/web/components/page";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { ProjectCard } from "@/web/components/project-card";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { CreateProjectDialog } from "@/web/components/create-project-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";

export default function ProjectsListPage() {
  const { org } = useProjectContext();
  const { data: projects, isLoading } = useProjects(org.id);
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const navigate = useNavigate();

  // Filter out org-admin and apply search
  const userProjects =
    projects
      ?.filter((p) => p.slug !== ORG_ADMIN_PROJECT_SLUG)
      ?.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.description?.toLowerCase().includes(search.toLowerCase()),
      ) ?? [];

  const handleSettingsClick = (projectSlug: string) => {
    navigate({
      to: "/$org/$project/projects/$slug/settings/general",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        slug: projectSlug,
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
          <Button
            onClick={handleCreateProject}
            size="sm"
            className="h-7 px-3 rounded-lg text-sm font-medium"
          >
            Create new project
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
        {/* Loading State */}
        {isLoading && (
          <div className="p-5">
            <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-[240px] rounded-xl bg-muted animate-pulse"
                />
              ))}
            </div>
          </div>
        )}

        {/* Empty State - No projects after filtering */}
        {!isLoading && userProjects.length === 0 && search && (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              title="No projects found"
              description={`No projects match "${search}"`}
            />
          </div>
        )}

        {/* Empty State - No projects at all */}
        {!isLoading && userProjects.length === 0 && !search && (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              title="No projects yet"
              description="Create a project to get started."
              actions={
                <Button onClick={handleCreateProject}>
                  Create new project
                </Button>
              }
            />
          </div>
        )}

        {/* Card Grid */}
        {!isLoading && userProjects.length > 0 && (
          <div className="p-5">
            <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
              {userProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onSettingsClick={() => handleSettingsClick(project.slug)}
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
