import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { KEYS } from "@/web/lib/query-keys";
import {
  ProjectContextProvider,
  useIsOrgAdmin,
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
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
}

/**
 * Sidebar content that reads from the current ProjectContext.
 * Renders org-level or project-level sidebar items depending on context.
 */
function SidebarContent({ onCreateProject }: MeshSidebarProps) {
  const sidebarSections = useProjectSidebarItems();
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

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data: entity } = useQuery({
    queryKey: KEYS.virtualMcp(org.id, virtualMcpId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_GET",
        arguments: { id: virtualMcpId },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as VirtualMCPEntity;
    },
    enabled: !!org.id && !!virtualMcpId,
    staleTime: 30000,
  });

  // While loading or if entity not found, fall back to org-level sidebar
  if (!entity) {
    return <SidebarContent onCreateProject={onCreateProject} />;
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
      <SidebarContent onCreateProject={onCreateProject} />
    </ProjectContextProvider>
  );
}

export function MeshSidebar({ onCreateProject }: MeshSidebarProps) {
  const params = useParams({ strict: false }) as {
    virtualMcpId?: string;
  };

  if (params.virtualMcpId) {
    return (
      <ProjectScopedSidebar
        virtualMcpId={params.virtualMcpId}
        onCreateProject={onCreateProject}
      />
    );
  }

  return <SidebarContent onCreateProject={onCreateProject} />;
}
