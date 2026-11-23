/** A project's home. */
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Navigate, useRouteContext } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { ProjectOverview } from "@/components/projects/project-overview";
import { useProjectScope } from "@/hooks/use-project-scope";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import {
  resolveProjectLandingTabId,
  withAppTakeoverState,
} from "@/layouts/main-panel-tabs/tab-id";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { tabRouteTarget } from "@/layouts/main-panel-tabs/tab-route";
import { useProjectContext } from "@/sdk";

function Overview() {
  const { org } = useProjectContext();
  const { project } = useProjectScope();
  const enteredProject = useRouteContext({
    from: "/shell/$org/org-shell/agent-shell/projects/$agentId/",
    select: (context) => context.enteredProject,
  });

  if (!project) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  /** Entering a project lands on the main view its settings name. */
  const layout = project.metadata?.ui?.layout ?? null;
  const landingTabId = enteredProject
    ? resolveProjectLandingTabId(
        layout
          ? {
              defaultMainView: layout.defaultMainView ?? null,
              tabs: layout.tabs?.map((tab) => ({ id: tab.id })),
            }
          : null,
      )
    : null;
  if (landingTabId) {
    const route = tabRouteTarget({
      tabId: landingTabId,
      org: org.slug,
      agentId: project.id,
    });
    /** A project whose main view is an MCP app IS that app: it opens full
     *  frame. Site editor and the native views keep the project around them. */
    if (route.to === PROJECT_ROUTE.app) {
      return (
        <Navigate
          to={PROJECT_ROUTE.app}
          params={route.params}
          state={withAppTakeoverState}
          replace
        />
      );
    }
    return <LegacyCanonicalNavigate target={{ route, search: route.search }} />;
  }

  return <ProjectOverview project={project} />;
}

export default function AgentOverviewRoute() {
  return (
    <ChatLayout.Content>
      <Overview />
    </ChatLayout.Content>
  );
}
