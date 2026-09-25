/**
 * The sidebar's project TREE, shown behind the project-first navigation flag.
 *
 * Projects were reachable only through the picker, which is a popover you have
 * to open to learn anything. Listing them costs one row each and turns the
 * sidebar into the map it was already pretending to be.
 *
 * The folders come from `lib/project-tree.ts`, which is where the rule lives:
 * a folder is a name a person pinned, or the owner of a repository two or more
 * projects share, and nothing else. An org with neither renders the same flat
 * list it rendered before — the tree appears when there IS a tree.
 *
 * Collapsed, the folders are dropped and every project shows at icon width. A
 * folder has no icon worth a 48px rail, and hiding projects one disclosure deep
 * in a rail you cannot read the label of is a list you cannot use.
 *
 * It lists PLACES and nothing else. Each project row used to carry up to three
 * cards waiting on you nested underneath, which made the nav a second board:
 * the same cards the org home already ranks, at a third of the width and with
 * no lane, no age and no way to act. A tree that answers "where" stays readable
 * at thirty projects; one that also answers "what" does not.
 */

import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";

import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, Plus } from "@untitledui/icons";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { useCapability } from "@/hooks/use-capability";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { ProjectIcon } from "@/components/project-icon";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useProjectScope, useScopeId } from "@/hooks/use-project-scope";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { useSearch } from "@tanstack/react-router";
import { buildProjectTree, type ProjectFolder } from "@/lib/project-tree";
import { FLAT_PROJECT_ROUTE } from "@/lib/flat-projects";
import { useLeafRoutePath } from "@/hooks/use-destination-route";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { SidebarNavRow } from "./nav-row";

/** One project, wherever it sits — loose at the root or inside a folder. */
function ProjectRow({
  project,
  isActive,
  onNavigate,
}: {
  project: VirtualMCPEntity;
  isActive: boolean;
  onNavigate?: () => void;
}) {
  const navigateToAgent = useNavigateToAgent();

  return (
    <SidebarNavRow
      icon={<ProjectIcon icon={project.icon} name={project.title} />}
      label={project.title}
      isActive={isActive}
      /** A button, not a link: these resolve a SESSION, so the destination id
       *  is not knowable at render time — the same reason `ProjectNav`'s rows
       *  are buttons. */
      onSelect={() => {
        track("sidebar_project_clicked");
        navigateToAgent(project.id);
        onNavigate?.();
      }}
    />
  );
}

/**
 * A folder and the projects in it.
 *
 * The disclosure is local state and starts open: a folder someone made is a
 * grouping, not a drawer, and a sidebar that hides every project until you
 * open two folders is worse than the flat list it replaced. Closing one is
 * for the org with thirty projects, and it does not need to survive a reload
 * to be worth having.
 */
function FolderRow({
  folder,
  selectedId,
  onNavigate,
}: {
  folder: ProjectFolder;
  selectedId: string | null;
  onNavigate?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);

  return (
    <SidebarNavRow
      icon={
        <>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Folder size={16} />
        </>
      }
      label={t(
        folder.kind === "code"
          ? "sidebar.projects.folderCode"
          : "sidebar.projects.folderOther",
      )}
      className="text-sidebar-foreground/70"
      onSelect={() => setOpen((it) => !it)}
    >
      {open && (
        <div className="mt-1 ml-4 border-sidebar-border border-l pl-2">
          <SidebarMenu className="gap-1">
            {folder.projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                isActive={project.id === selectedId}
                onNavigate={onNavigate}
              />
            ))}
          </SidebarMenu>
        </div>
      )}
    </SidebarNavRow>
  );
}

export function SidebarProjectsTree({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const { granted: canManageProjects } = useCapability("agents:manage");
  const { projects } = useProjectScope();
  const scopeId = useScopeId();
  const leafPath = useLeafRoutePath();
  const search = useSearch({ strict: false }) as { project?: string };

  /** ORG scope only. Inside a project the sidebar is already about THAT
   *  project — its own views sit right above this — so a list of every project
   *  underneath them turns the one place that says where you are into a place
   *  that says where you could be instead. The picker and the way back out are
   *  the controls for leaving; this section is the org's map. */
  if (scopeId || (projects.length === 0 && !canManageProjects)) return null;

  /** Collapsed there is no room for a folder, so the tree flattens back to the
   *  list of every project — see this module's docblock. */
  const tree = collapsed
    ? { folders: [], loose: projects }
    : buildProjectTree(projects);
  const canAdd = canManageProjects;
  /** This tree IS the selection control — picking a row swaps the screen beside
   *  it rather than entering anywhere — so the row you are looking at has to
   *  read as chosen. Keyed on the ROUTE as well as the param because
   *  neighbouring links spread the current search forward: `?project=` outlives
   *  the screen that meant it, and a project lit up while the org board is open
   *  names the wrong place. */
  const selectedId =
    leafPath === FLAT_PROJECT_ROUTE ? (search.project?.trim() ?? null) : null;

  return (
    <div
      className="flex flex-col gap-2"
      data-tour={LAYOUT_TOUR_ANCHORS.projects}
    >
      {!collapsed && (
        <div className="flex h-6 items-center justify-between gap-2 px-2">
          <p className="font-medium text-xs text-muted-foreground">
            {t("sidebar.projects.heading")}
          </p>
          {canAdd && (
            <button
              type="button"
              aria-label={t("projects.home.newProject")}
              title={t("projects.home.newProject")}
              onClick={() => openNewProjectDialog("sidebar")}
              className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      )}
      <SidebarMenu className="gap-1">
        {tree.folders.map((folder) => (
          <FolderRow
            key={folder.kind}
            folder={folder}
            selectedId={selectedId}
            onNavigate={onNavigate}
          />
        ))}
        {tree.loose.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            isActive={project.id === selectedId}
            onNavigate={onNavigate}
          />
        ))}
        {/* Collapsed, the heading and its `+` are gone, so the rail keeps the
            row it always had. */}
        {canAdd && collapsed && (
          <SidebarNavRow
            icon={<Plus size={16} />}
            label={t("projects.home.newProject")}
            onSelect={() => openNewProjectDialog("sidebar")}
          />
        )}
      </SidebarMenu>
    </div>
  );
}
