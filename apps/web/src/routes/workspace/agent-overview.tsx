/** A project's home: the new Overview with project-first nav, the classic tab without. */
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ChatLayout } from "@/components/chat-layout";
import { ProjectOverview } from "@/components/projects/project-overview";
import { OverviewTab } from "@/layouts/main-panel-tabs/overview-tab";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useProjectScope } from "@/hooks/use-project-scope";

function FlagOverview() {
  const { project } = useProjectScope();
  if (!project) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return <ProjectOverview project={project} />;
}

export default function AgentOverviewRoute() {
  const projectFirstNav = useProjectFirstNav();
  return (
    <ChatLayout.Content>
      {projectFirstNav ? <FlagOverview /> : <OverviewTab />}
    </ChatLayout.Content>
  );
}
