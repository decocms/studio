/**
 * A project's files.
 *
 * The same Library, rooted at the project's own folder — see
 * `layouts/library/project-folder.ts` for why a project IS a folder. Nothing
 * above that folder is reachable from here: walking up out of a project into
 * the org's drive would leave you in a project's chrome looking at another
 * project's files.
 */
import { ChatLayout } from "@/components/chat-layout";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";
import { useProjectScope } from "@/hooks/use-project-scope";
import { projectFolderPath } from "@/layouts/library/project-folder";

export default function AgentLibraryRoute() {
  const { project } = useProjectScope();
  return (
    <ChatLayout.Content>
      {/* Remounts when the project resolves, so the tree is never briefly
          rooted at the drive under a project's name. */}
      <LibraryTab
        key={project?.id ?? "pending"}
        root={project ? projectFolderPath(project) : undefined}
        rootLabel={project?.title ?? undefined}
      />
    </ChatLayout.Content>
  );
}
