import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import {
  ProjectContextProvider,
  useIsOrgAdmin,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { useMatch } from "@tanstack/react-router";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MeshSidebarHeader } from "./header";
import { SidebarInboxFooter } from "./footer/inbox";
import { SidebarProjectsSection } from "./projects-section";

// Export types for external use
export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

interface MeshSidebarProps {
  onCreateProject?: () => void;
  virtualMcpId?: string;
}

/**
 * Sidebar content that reads from the current ProjectContext.
 * Renders org-level or project-level sidebar items depending on context.
 */
function SidebarContent({ onCreateProject, virtualMcpId }: MeshSidebarProps) {
  const sidebarSections = useProjectSidebarItems({ virtualMcpId });
  const isOrgAdmin = useIsOrgAdmin();

  return (
    <NavigationSidebar
      sections={sidebarSections}
      header={
        <Suspense fallback={<MeshSidebarHeader.Skeleton />}>
          <MeshSidebarHeader onCreateProject={onCreateProject} />
        </Suspense>
      }
      footer={<SidebarInboxFooter />}
      additionalContent={
        isOrgAdmin ? (
          <ErrorBoundary>
            <Suspense fallback={null}>
              <SidebarProjectsSection />
            </Suspense>
          </ErrorBoundary>
        ) : null
      }
    />
  );
}

/**
 * When on a /$org/projects/$virtualMcpId route, wraps the sidebar in a
 * ProjectContextProvider scoped to the virtual MCP so that
 * useProjectSidebarItems() returns project-level items.
 */
function ProjectScopedSidebar({
  virtualMcpId,
  onCreateProject,
}: {
  virtualMcpId: string;
  onCreateProject?: () => void;
}) {
  const { org } = useProjectContext();

  const entity = useVirtualMCP(virtualMcpId);

  // While loading or if entity not found, fall back to org-level sidebar
  if (!entity) {
    return (
      <SidebarContent
        onCreateProject={onCreateProject}
        virtualMcpId={virtualMcpId}
      />
    );
  }

  const slug =
    (entity.metadata?.migrated_project_slug as string | undefined) ??
    ((entity.metadata?.ui as Record<string, unknown> | null | undefined)
      ?.slug as string | undefined) ??
    entity.id;

  const projectData = {
    id: entity.id,
    organizationId: org.id,
    slug,
    name: entity.title,
    description: entity.description,
    enabledPlugins:
      (entity.metadata?.enabled_plugins as string[] | null | undefined) ?? null,
    ui: entity.metadata?.ui
      ? {
          banner:
            ((entity.metadata.ui as Record<string, unknown>).banner as
              | string
              | null) ?? null,
          bannerColor:
            ((entity.metadata.ui as Record<string, unknown>).bannerColor as
              | string
              | null) ?? null,
          icon:
            ((entity.metadata.ui as Record<string, unknown>).icon as
              | string
              | null) ?? null,
          themeColor:
            ((entity.metadata.ui as Record<string, unknown>).themeColor as
              | string
              | null) ?? null,
        }
      : null,
    isOrgAdmin: false,
  };

  return (
    <ProjectContextProvider org={org} project={projectData}>
      <SidebarContent
        onCreateProject={onCreateProject}
        virtualMcpId={virtualMcpId}
      />
    </ProjectContextProvider>
  );
}

export function MeshSidebar({
  onCreateProject,
}: Omit<MeshSidebarProps, "virtualMcpId">) {
  const projectMatch = useMatch({
    from: "/shell/$org/projects/$virtualMcpId",
    shouldThrow: false,
  });
  const virtualMcpId = projectMatch?.params.virtualMcpId;

  if (virtualMcpId) {
    return (
      <ProjectScopedSidebar
        virtualMcpId={virtualMcpId}
        onCreateProject={onCreateProject}
      />
    );
  }

  return <SidebarContent onCreateProject={onCreateProject} />;
}
