/**
 * A project's files.
 *
 * The same Library, rooted at the project's own folder — see
 * `@decocms/shared/organization/project-folder` for why a project IS a folder. Nothing
 * above that folder is reachable from here: walking up out of a project into
 * the org's drive would leave you in a project's chrome looking at another
 * project's files.
 */
import { Navigate, useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";
import { useEnsureProjectFolder } from "@/hooks/use-ensure-project-folder";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import {
  ContextShell,
  movedToSettings,
  projectSection,
} from "@/layouts/context/context-shell";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useProjectContext } from "@/sdk";
import type { ContextSection } from "@/lib/legacy-workspace-search";
import { VirtualMcpDetailView } from "@/views/virtual-mcp";
import { projectFolderPath } from "@decocms/shared/organization/project-folder";

/** Under project-first nav: the project's Context, its files plus its settings. */
export default function AgentLibraryRoute() {
  const { project } = useProjectScope();
  const { org } = useProjectContext();
  const t = useT();
  const projectFirstNav = useProjectFirstNav();
  const { section } = useSearch({ strict: false }) as {
    section?: ContextSection;
  };
  useEnsureProjectFolder(project);
  /* Remounts once the project resolves, never briefly rooted at the drive. */
  const files = (
    <LibraryTab
      key={project?.id ?? "pending"}
      root={project ? projectFolderPath(project) : undefined}
      rootLabel={
        projectFirstNav
          ? t("sidebar.navDestinations.context")
          : (project?.title ?? undefined)
      }
      filePreview={projectFirstNav ? "dialog" : undefined}
      context={projectFirstNav}
    />
  );
  if (!projectFirstNav) return <ChatLayout.Content>{files}</ChatLayout.Content>;

  const moved = movedToSettings(section);
  if (moved && project) {
    return (
      <Navigate
        to={PROJECT_ROUTE.settings}
        params={{ org: org.slug, agentId: project.id }}
        search={{ section: moved === "general" ? undefined : moved }}
        replace
      />
    );
  }

  const current = projectSection(section);
  return (
    <ChatLayout.Content>
      <ContextShell scope="project" section={current}>
        {current === "files" ? (
          files
        ) : project ? (
          <VirtualMcpDetailView
            virtualMcpId={project.id}
            contextSection={current}
          />
        ) : null}
      </ContextShell>
    </ChatLayout.Content>
  );
}
