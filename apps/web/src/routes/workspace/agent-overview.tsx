/** A project's home. */
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ChatLayout } from "@/components/chat-layout";
import { ProjectOverview } from "@/components/projects/project-overview";
import { useProjectScope } from "@/hooks/use-project-scope";

function Overview() {
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
  return (
    <ChatLayout.Content>
      <Overview />
    </ChatLayout.Content>
  );
}
