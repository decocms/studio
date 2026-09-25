/**
 * A project's home.
 *
 * Under project-first navigation it is the board. The org home is the daily
 * brief — it answers what changed and what is stopped on you across every
 * project. Once you have picked a project out of it, the question is no
 * longer "what happened" but "what is in flight", and that is the board. A
 * second, narrower brief in front of it was one more page between the reader
 * and the work.
 *
 * The same page as the Board destination, deliberately: a project has one
 * board, and rendering a copy here would give it two that drift. Card
 * deep-links keep their own route (`PROJECT_ROUTE.tasks`), which carries the
 * card key this one has no segment for.
 *
 * With the flag off it keeps the project overview it always had.
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
