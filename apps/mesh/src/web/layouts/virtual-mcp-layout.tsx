/**
 * Virtual MCP Layout
 *
 * Wraps virtual MCP detail routes (/$org/p/$virtualMcpId/...).
 * Fetches the virtual MCP by ID and provides it as project context
 * for backward compatibility with components that rely on useProjectContext().
 */

import { Outlet, useParams, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { SplashScreen } from "@/web/components/splash-screen";
import { ProjectContextProvider, useProjectContext } from "@decocms/mesh-sdk";
import { useMCPClient, SELF_MCP_ALIAS_ID } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { SettingsModal } from "@/web/components/settings-modal/index";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";

/**
 * Error display for when a virtual MCP is not found
 */
function VirtualMCPNotFoundError({
  virtualMcpId,
  orgSlug,
}: {
  virtualMcpId: string;
  orgSlug: string;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <h1 className="text-xl font-semibold">Project not found</h1>
      <p className="text-muted-foreground text-center">
        The project "{virtualMcpId}" does not exist in this organization.
      </p>
      <Button
        variant="link"
        onClick={() =>
          navigate({
            to: "/$org",
            params: { org: orgSlug },
          })
        }
      >
        Go to organization home
      </Button>
    </div>
  );
}

/**
 * Error display for when a virtual MCP request fails
 */
function VirtualMCPRequestError({
  virtualMcpId,
  orgSlug,
  error,
}: {
  virtualMcpId: string;
  orgSlug: string;
  error: Error;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <h1 className="text-xl font-semibold">Failed to load project</h1>
      <p className="text-muted-foreground text-center">
        There was an error loading the project "{virtualMcpId}".
      </p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button
        variant="link"
        onClick={() =>
          navigate({
            to: "/$org",
            params: { org: orgSlug },
          })
        }
      >
        Go to organization home
      </Button>
    </div>
  );
}

/**
 * Inner component that fetches virtual MCP data and provides project context.
 * Must be rendered inside shell-layout's ProjectContextProvider to access org data.
 */
function VirtualMCPLayoutContent() {
  const params = useParams({ strict: false });
  const { org } = useProjectContext();

  const orgSlug = params.org as string;
  const virtualMcpId = params.virtualMcpId as string;

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch the virtual MCP by ID
  const {
    data: entity,
    isLoading,
    error,
  } = useQuery({
    queryKey: KEYS.virtualMcp(org.id, virtualMcpId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_GET",
        arguments: {
          id: virtualMcpId,
        },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as VirtualMCPEntity;
    },
    enabled: !!org.id && !!virtualMcpId,
    staleTime: 30000,
  });

  // Loading state
  if (isLoading) {
    return <SplashScreen />;
  }

  // Error handling
  if (error) {
    return (
      <VirtualMCPRequestError
        virtualMcpId={virtualMcpId}
        orgSlug={orgSlug}
        error={error}
      />
    );
  }

  // Not found
  if (!entity) {
    return (
      <VirtualMCPNotFoundError virtualMcpId={virtualMcpId} orgSlug={orgSlug} />
    );
  }

  // Map virtual MCP entity to project context
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
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
    </ProjectContextProvider>
  );
}

export default function VirtualMCPLayout() {
  return (
    <Suspense fallback={<SplashScreen />}>
      <VirtualMCPLayoutContent />
    </Suspense>
  );
}
