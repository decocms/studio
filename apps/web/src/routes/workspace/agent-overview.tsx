/** A project's home. */
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useRouteContext } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { ProjectOverview } from "@/components/projects/project-overview";
import { useProjectScope } from "@/hooks/use-project-scope";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import { resolveProjectLandingTabId } from "@/layouts/main-panel-tabs/tab-id";
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
