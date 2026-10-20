/**
 * A project's home: the board under project-first navigation, the project
 * overview with the flag off.
 *
 * Literally the Board destination's page, so a project cannot end up with two
 * boards that drift. Card deep-links keep `PROJECT_ROUTE.tasks`, which carries
 * the key this route has no segment for.
 */
import { ChatLayout } from "@/components/chat-layout";
import { OverviewTab } from "@/layouts/main-panel-tabs/overview-tab";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import ProjectTasksRoute from "./project-tasks";

export default function AgentOverviewRoute() {
  const projectFirstNav = useProjectFirstNav();
  if (projectFirstNav) return <ProjectTasksRoute />;
  return (
    <ChatLayout.Content>
      <OverviewTab />
    </ChatLayout.Content>
  );
}
