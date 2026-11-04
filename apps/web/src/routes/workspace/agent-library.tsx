/**
 * A project's files.
 *
 * The same Library, rooted at the project's own folder — see
 * `@decocms/shared/organization/project-folder` for why a project IS a folder. Nothing
 * above that folder is reachable from here: walking up out of a project into
 * the org's drive would leave you in a project's chrome looking at another
 * project's files.
 */
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { ChatLayout, useChatLayout } from "@/components/chat-layout";
import { Page } from "@/components/page";
import { basename } from "@/layouts/library/location";
import { LibraryPreviewPanel } from "@/layouts/library/preview-panel";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";
import { useEnsureProjectFolder } from "@/hooks/use-ensure-project-folder";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import {
  ContextShell,
  ProjectSkillsSection,
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
  const navigate = useNavigate();
  const { section, preview, expanded } = useSearch({ strict: false }) as {
    section?: ContextSection;
    preview?: string;
    expanded?: boolean;
  };
  /** A skill opens beside the table, and takes the page while the chat is
   *  open beside it — the org's Skills behaviour. */
  const isMobile = useIsMobile();
  const chatBeside = useChatLayout().threadOpen && !isMobile;
  const show = (next: { preview?: string; expanded?: true }) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: next.preview,
        expanded: next.expanded,
      }),
    });
  const close = () => show({});
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
  const previewing = current === "skills" && preview ? preview : null;

  if (previewing && (expanded || chatBeside)) {
    const folder = previewing.slice(
      0,
      Math.max(previewing.lastIndexOf("/"), 0),
    );
    return (
      <ChatLayout.Content>
        <Page.Breadcrumbs
          after="page"
          parent={{ onSelect: close }}
          items={[{ key: "file", label: basename(folder) }]}
        />
        <LibraryPreviewPanel
          key={previewing}
          previewPath={previewing}
          onClose={close}
          expand={{
            expanded: true,
            onToggle: chatBeside
              ? undefined
              : () => show({ preview: previewing }),
          }}
        />
      </ChatLayout.Content>
    );
  }

  return (
    <ChatLayout.Content
      aside={
        previewing && (
          <LibraryPreviewPanel
            key={previewing}
            variant="aside"
            previewPath={previewing}
            onClose={close}
            expand={{
              expanded: false,
              onToggle: () => show({ preview: previewing, expanded: true }),
            }}
          />
        )
      }
    >
      <ContextShell scope="project" section={current}>
        {current === "files" ? (
          files
        ) : !project ? null : current === "skills" ? (
          <ProjectSkillsSection
            key={project.id}
            project={{ id: project.id, skills: project.metadata?.skills ?? [] }}
          />
        ) : (
          <VirtualMcpDetailView
            virtualMcpId={project.id}
            contextSection={current}
          />
        )}
      </ContextShell>
    </ChatLayout.Content>
  );
}
