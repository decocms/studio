/**
 * One project, without entering it (see `lib/flat-projects.ts`): the sidebar
 * keeps the org's nav, so there is no scope to leave.
 *
 * `?project=` and not a path segment: a segment is what makes `useScopeId`
 * narrow the shell, which this screen exists not to do. The scoped route
 * `/$org/projects/$agentId` is untouched beside it.
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

/** The project, or its files. In the topbar, not the toolbar: the toolbar row
 *  belongs to the board's own Board/List/Feed. */
function ProjectViewToggle({ files }: { files: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  /** Opening the files closes an open card, which would otherwise re-open on
   *  the way back. */
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
    // Right, not Left: Left is `overflow-hidden` and clips this.
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

/** The same Library every other surface uses, rooted at the project's folder.
 *  `filePreview="dialog"` because this screen has no main-panel tabs. */
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

  /** No `?id=` means a bare link, so land on the most recently touched
   *  project rather than an empty frame. */
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
    /* Not `Page`: `Page.Content` scrolls, and the board owns its scrolling. */
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
