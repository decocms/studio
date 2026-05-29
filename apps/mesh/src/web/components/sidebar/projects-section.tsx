import { Suspense, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import {
  ChevronDown,
  DotsHorizontal,
  LayoutLeft,
  Plus,
  Settings01,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useProjects } from "@/web/hooks/use-projects";
import { useCreateProject } from "@/web/hooks/use-create-project";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";

function ProjectListItem({
  project,
  org,
}: {
  project: VirtualMCPEntity;
  org: string;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const [isOpen, setIsOpen] = useState(false);

  const pinnedViews =
    ((project.metadata?.ui as Record<string, unknown> | null | undefined)
      ?.pinnedViews as Array<{
      connectionId: string;
      toolName: string;
      label: string;
      icon: string | null;
    }> | null) ?? [];

  const projectBasePath = `/${org}/projects/${project.id}`;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip={project.title}
            className="group/project-row h-9"
          >
            {/* Icon: show avatar by default, chevron on hover */}
            <span className="relative shrink-0 size-4 flex items-center justify-center mr-1">
              <span className="group-hover/project-row:hidden">
                <AgentAvatar
                  icon={project.icon}
                  name={project.title}
                  size="xs"
                />
              </span>
              <ChevronDown
                size={14}
                className={cn(
                  "hidden group-hover/project-row:block text-muted-foreground transition-transform duration-200",
                  !isOpen && "-rotate-90",
                )}
              />
            </span>
            <span className="truncate flex-1 group-data-[collapsible=icon]:hidden">
              {project.title}
            </span>
            {/* Gear icon: visible on hover */}
            <button
              type="button"
              className="text-muted-foreground opacity-0 group-hover/project-row:opacity-100 transition-opacity group-data-[collapsible=icon]:hidden shrink-0 p-1 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                navigate({
                  to: "/$org/projects/$virtualMcpId/settings",
                  params: { org, virtualMcpId: project.id },
                });
              }}
            >
              <Settings01 size={16} />
            </button>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-0.5 flex flex-col gap-0.5">
          {pinnedViews.map((view) => {
            const viewPath = `${projectBasePath}/apps/${view.connectionId}/${encodeURIComponent(view.toolName)}`;
            const isActive = pathname.startsWith(viewPath);
            return (
              <SidebarMenuButton
                key={`${view.connectionId}-${view.toolName}`}
                isActive={isActive}
                className="pl-7"
                onClick={() =>
                  navigate({
                    to: "/$org/projects/$virtualMcpId/apps/$connectionId/$toolName",
                    params: {
                      org,
                      virtualMcpId: project.id,
                      connectionId: view.connectionId,
                      toolName: view.toolName,
                    },
                  })
                }
              >
                {view.icon ? (
                  <img
                    src={view.icon}
                    alt=""
                    className="size-4 rounded shrink-0"
                  />
                ) : (
                  <LayoutLeft size={16} className="shrink-0" />
                )}
                <span className="truncate">{view.label || view.toolName}</span>
              </SidebarMenuButton>
            );
          })}
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function ProjectsSectionContent() {
  const projects = useProjects();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(true);
  const { createProject } = useCreateProject();

  return (
    <>
      <div className="group/projects-section mt-2">
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <SidebarGroup className="py-0 px-0">
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {/* Section Header */}
                <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
                  <div className="flex h-8 w-full items-center gap-1 rounded-md pl-2 pr-1">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-1 cursor-pointer min-w-0"
                      >
                        <span className="text-xs font-medium text-muted-foreground">
                          Projects
                        </span>
                        <ChevronDown
                          size={12}
                          className={cn(
                            "text-muted-foreground shrink-0 transition-transform duration-200",
                            !isOpen && "-rotate-90",
                          )}
                        />
                      </button>
                    </CollapsibleTrigger>
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          to: "/$org/projects",
                          params: { org: org.slug },
                        })
                      }
                      title="View all projects"
                      className="opacity-0 group-hover/projects-section:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex items-center justify-center size-6 rounded shrink-0"
                    >
                      <DotsHorizontal size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={createProject}
                      title="Create new project"
                      className="opacity-0 group-hover/projects-section:opacity-100 transition-opacity text-muted-foreground hover:text-foreground flex items-center justify-center size-6 rounded shrink-0"
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                </SidebarMenuItem>

                {/* Project List */}
                <CollapsibleContent>
                  {projects.length === 0 ? (
                    <SidebarMenuItem>
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        No projects yet
                      </div>
                    </SidebarMenuItem>
                  ) : (
                    projects.map((project) => (
                      <ProjectListItem
                        key={project.id}
                        project={project}
                        org={org.slug}
                      />
                    ))
                  )}
                </CollapsibleContent>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Collapsible>
      </div>
    </>
  );
}

export function SidebarProjectsSection() {
  return (
    <Suspense
      fallback={
        <SidebarGroup className="py-0 px-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
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
      <ProjectsSectionContent />
    </Suspense>
  );
}
