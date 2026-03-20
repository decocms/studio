/**
 * Org Layout
 *
 * Wraps all org-level routes. Provides a synthetic project context
 * for backward compatibility with components that rely on useProjectContext().
 *
 * The synthetic project has isOrgAdmin = true and uses the org's ID as the project ID.
 */

import { Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { SplashScreen } from "@/web/components/splash-screen";
import { ProjectContextProvider, useProjectContext } from "@decocms/mesh-sdk";
import { SettingsModal } from "@/web/components/settings-modal/index";

/**
 * Inner component that provides a synthetic org-admin project context.
 * Must be rendered inside shell-layout's ProjectContextProvider to access org data.
 */
function OrgLayoutContent() {
  const { org } = useProjectContext();

  // Build a synthetic project context for org-level views.
  // This keeps all existing components that call useProjectContext() working.
  const syntheticProject = {
    id: org.id,
    organizationId: org.id,
    slug: "_org",
    name: org.name,
    isOrgAdmin: true,
    enabledPlugins: null,
    ui: null,
  };

  return (
    <ProjectContextProvider org={org} project={syntheticProject}>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
    </ProjectContextProvider>
  );
}

export default function OrgLayout() {
  return (
    <Suspense fallback={<SplashScreen />}>
      <OrgLayoutContent />
    </Suspense>
  );
}
