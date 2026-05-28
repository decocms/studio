/**
 * Virtual MCP Layout
 *
 * Wraps virtual MCP detail routes (/$org/projects/$virtualMcpId/...).
 * Fetches the virtual MCP by ID and provides it as project context
 * for backward compatibility with components that rely on useProjectContext().
 */

import { Outlet, useNavigate, useMatch } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";
import { SplashScreen } from "@/web/components/splash-screen";
import {
  ProjectContextProvider,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";

import { useChatStable } from "@/web/components/chat/context";

/**
 * Inner component that fetches virtual MCP data and provides project context.
 * Must be rendered inside shell-layout's ProjectContextProvider to access org data.
 */
function VirtualMCPLayoutContent() {
  // Support both /spaces/$virtualMcpId and /projects/$virtualMcpId routes
  const spacesMatch = useMatch({
    from: "/shell/$org/spaces/$virtualMcpId",
    shouldThrow: false,
  });
  const projectsMatch = useMatch({
    from: "/shell/$org/projects/$virtualMcpId",
    shouldThrow: false,
  });
  const match = spacesMatch ?? projectsMatch;
  const { org } = useProjectContext();
  const { setVirtualMcpId } = useChatStable();
  const navigate = useNavigate();

  const orgSlug = match?.params.org ?? "";
  const virtualMcpId = match?.params.virtualMcpId ?? "";

  // Fetch using the same SDK hook as agent-detail (suspense-based)
  const entity = useVirtualMCP(virtualMcpId);

  // Select this virtual MCP in the chat store
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!entity) return;
    setVirtualMcpId(entity.id);
  }, [entity?.id]);

  // Not found
  if (!entity) {
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
    enabledPlugins: entity.metadata?.enabled_plugins as
      | string[]
      | null
      | undefined,
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
          pinnedViews:
            ((entity.metadata.ui as Record<string, unknown>)
              .pinnedViews as Array<{
              connectionId: string;
              toolName: string;
              label: string;
              icon: string | null;
            }> | null) ?? null,
        }
      : null,
    isOrgAdmin: false,
  };

  return (
    <ProjectContextProvider org={org} project={projectData}>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
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
