/**
 * Project Layout
 *
 * Wraps all project-scoped routes. Fetches project data from storage
 * based on URL params and provides enhanced context to child components.
 *
 * The shell-layout above provides basic organization context. This layout
 * enhances it with full project data when available, or handles error states
 * when the project doesn't exist.
 */

import { Outlet, useParams, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { SplashScreen } from "@/web/components/splash-screen";
import { useProject } from "@/web/hooks/use-project";
import { ProjectContextProvider, useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { SettingsModal } from "@/web/components/settings-modal/index";

/**
 * Error display for when a project request fails
 */
function ProjectRequestError({
  projectSlug,
  orgSlug,
  error,
}: {
  projectSlug: string;
  orgSlug: string;
  error: Error;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <h1 className="text-xl font-semibold">Failed to load project</h1>
      <p className="text-muted-foreground text-center">
        There was an error loading the project "{projectSlug}".
      </p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button
        variant="link"
        onClick={() =>
          navigate({
            to: "/$org/$project",
            params: { org: orgSlug, project: "org-admin" },
          })
        }
      >
        Go to organization home
      </Button>
    </div>
  );
}

/**
 * Error display for when a project is not found
 */
function ProjectNotFoundError({
  projectSlug,
  orgSlug,
}: {
  projectSlug: string;
  orgSlug: string;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <h1 className="text-xl font-semibold">Project not found</h1>
      <p className="text-muted-foreground text-center">
        The project "{projectSlug}" does not exist in this organization.
      </p>
      <Button
        variant="link"
        onClick={() =>
          navigate({
            to: "/$org/$project",
            params: { org: orgSlug, project: "org-admin" },
          })
        }
      >
        Go to organization home
      </Button>
    </div>
  );
}

/**
 * Inner component that fetches project data and provides enhanced context.
 * Must be rendered inside shell-layout's ProjectContextProvider to access org data.
 */
function ProjectLayoutContent() {
  const params = useParams({ strict: false });
  const { org } = useProjectContext();

  const orgSlug = params.org as string;
  const projectSlug = params.project as string;

  // Fetch project data from storage
  const { data: project, isLoading, error } = useProject(org.id, projectSlug);

  // Loading state
  if (isLoading) {
    return <SplashScreen />;
  }

  // Error handling - request failed (network/permission errors)
  if (error) {
    return (
      <ProjectRequestError
        projectSlug={projectSlug}
        orgSlug={orgSlug}
        error={error}
      />
    );
  }

  // Project not found
  if (!project) {
    return <ProjectNotFoundError projectSlug={projectSlug} orgSlug={orgSlug} />;
  }

  // Build enhanced context value with full project data
  const enhancedProject = {
    id: project.id,
    organizationId: project.organizationId,
    slug: project.slug,
    name: project.name,
    description: project.description,
    enabledPlugins: project.enabledPlugins,
    ui: project.ui,
    isOrgAdmin: project.slug === "org-admin",
  };

  return (
    <ProjectContextProvider org={org} project={enhancedProject}>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
    </ProjectContextProvider>
  );
}

export default function ProjectLayout() {
  return (
    <Suspense fallback={<SplashScreen />}>
      <ProjectLayoutContent />
    </Suspense>
  );
}
