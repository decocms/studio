/**
 * One project, without entering it.
 *
 * The alternative shape (see `lib/flat-projects.ts`): the sidebar keeps the
 * organization's nav and its project list, and picking a project opens this —
 * its identity, the apps it can launch, and its board. There is no scope to
 * leave, so there is no "All projects" to come back through.
 *
 * `?project=` and not a path segment, deliberately: a path segment is what
 * makes `useScopeId` narrow the shell, and this screen exists precisely to not
 * do that. The scoped route (`/$org/projects/$agentId`) is untouched beside it.
 *
 * A project is two things you can look at — the project, and its files — and
 * with no sidebar here to list them, `?files` and the topbar toggle below are
 * how you get between them.
 */

import { Suspense } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Folder, Grid01 } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ViewModeToggle } from "@decocms/ui/components/view-mode-toggle.tsx";
import { ChatLayout } from "@/components/chat-layout";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { ProjectApps } from "@/components/projects/project-apps";
import { ProjectsEmptyState } from "@/components/projects/projects-empty-state";
import { TaskBoardPage } from "@/layouts/task-board";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";
import { projectFolderPath } from "@/layouts/library/project-folder";
import { useCapability } from "@/hooks/use-capability";
import { scopableProjects } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t";
import { useProjectContext, useVirtualMCPs } from "@/sdk";

/**
 * The project, or its files.
 *
 * In the topbar beside the project's name and not in the toolbar under it:
 * the toolbar row belongs to the board, which has its own Board/List/Feed
 * there, and a second switch beside those would read as a fourth view of the
 * board rather than a different thing to look at.
 */
function ProjectViewToggle({ files }: { files: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  /** Opening the files closes an open card: the card is a view of the board,
   *  and leaving it in the URL would re-open it on the way back with no way
   *  to tell that from a fresh link. */
  const go = (next: boolean | undefined) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        files: next,
        ...(next ? { task: undefined } : {}),
      }),
    });

  return (
    // Right, not Left: Left is `overflow-hidden` for breadcrumb truncation and clips this instead.
    <Panel.Topbar.Right.Portal>
      <div className="shrink-0">
        <ViewModeToggle
          value={files ? "files" : "project"}
          onValueChange={(next) => go(next === "files" ? true : undefined)}
          options={[
            {
              value: "project",
              icon: <Grid01 />,
              label: t("projects.flat.viewProject"),
            },
            {
              value: "files",
              icon: <Folder />,
              label: t("projects.flat.viewFiles"),
            },
          ]}
        />
      </div>
    </Panel.Topbar.Right.Portal>
  );
}

/** A project's files: the same Library every other surface uses, rooted at the
 *  project's own folder so walking up cannot land in another project's.
 *
 *  `filePreview="dialog"` because this screen has no main-panel tabs to open a
 *  file into — see `LibraryTab`. */
function ProjectFiles({ project }: { project: VirtualMCPEntity }) {
  return (
    <LibraryTab
      key={project.id}
      root={projectFolderPath(project)}
      rootLabel={project.title ?? undefined}
      filePreview="dialog"
    />
  );
}

function FlatProjectBody({
  projectId,
  taskOpen,
  files,
}: {
  projectId: string | undefined;
  /** A card is open (`?task=`), so the board region below is showing that card
   *  instead of the feed. */
  taskOpen: boolean;
  /** `?files` — show the project's files instead of the project. */
  files: boolean;
}) {
  const { org } = useProjectContext();
  const { granted: canManageProjects } = useCapability("agents:manage");
  const all = useVirtualMCPs({ pageSize: 1000 });
  const projects = scopableProjects(all).filter((p) => p.id !== org.id);

  if (projects.length === 0) {
    return <ProjectsEmptyState canCreate={canManageProjects} />;
  }

  /** No `?id=` lands on the most recently touched project rather than an empty
   *  frame: this screen is reached by picking one, so arriving without a pick
   *  means a bare link, and the newest project is the best guess available. */
  const project =
    projects.find((p) => p.id === projectId) ??
    [...projects].sort((a, b) =>
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    )[0];
  if (!project) return null;

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col">
      <ProjectViewToggle files={files} />
      {files ? (
        <ProjectFiles project={project} />
      ) : (
        <>
          {/* The actual `Page.Container` — not classes copied from it — so this
          row can never drift from what every other page pads itself with. */}
          {/* Apps: what you can open. Renders nothing for a project with none, and
          nothing while a card is open — a launcher above someone reading one
          card is the rest of the project talking over it. */}
          {!taskOpen && (
            <Page.Container className="flex max-w-[1680px] shrink-0 flex-col gap-4 pb-6">
              <ProjectApps project={project} orgSlug={org.slug} />
            </Page.Container>
          )}
          {/* Given the project explicitly: this route carries no `$agentId`.
          `inlineTabs` puts Board/List/Feed at the top of the board instead of
          in the panel toolbar — up there they would read as switching this
          whole screen rather than the one region they actually switch.
          `taskInSearch` because this route owns no `{-$taskKey}` segment and
          cannot grow one (see `projectsIndexRoute`): a card opens at
          `?project=…&task=DECO-01`, in place, on this same screen. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <TaskBoardPage scopeProject={project} inlineTabs taskInSearch />
          </div>
        </>
      )}
    </div>
  );
}

export default function FlatProjectRoute() {
  const search = useSearch({ strict: false }) as {
    project?: string;
    task?: string;
    files?: boolean;
  };
  return (
    /* The board's own frame, not `Page`: `Page.Content` scrolls, and the board
       already owns its scrolling. */
    <ChatLayout.Content>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Suspense
          fallback={
            <div className="flex min-h-64 items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
        >
          <FlatProjectBody
            projectId={search.project}
            taskOpen={!!search.task}
            files={!!search.files}
          />
        </Suspense>
      </div>
    </ChatLayout.Content>
  );
}
