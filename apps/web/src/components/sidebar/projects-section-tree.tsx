/**
 * The sidebar's project TREE, behind the project-first navigation flag.
 *
 * Folders come from `lib/project-tree.ts`; an org with none renders the same
 * flat list as before. Collapsed, folders are dropped and every project shows
 * at icon width.
 *
 * It lists PLACES only — cards nested under a project row made the nav a
 * second, worse board.
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
      /** A button, not a link: these resolve a session, so the destination id
       *  is not knowable at render time. */
      onSelect={() => {
        track("sidebar_project_clicked");
        navigateToAgent(project.id);
        onNavigate?.();
      }}
    />
  );
}

/** A folder and the projects in it. The disclosure is local state and starts
 *  open — a folder is a grouping, not a drawer. */
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

  /** ORG scope only: inside a project the sidebar is already about that
   *  project, and the picker is the control for leaving it. */
  if (scopeId || (projects.length === 0 && !canManageProjects)) return null;

  /** Collapsed there is no room for a folder, so the tree flattens. */
  const tree = collapsed
    ? { folders: [], loose: projects }
    : buildProjectTree(projects);
  const canAdd = canManageProjects;
  /** Keyed on the ROUTE as well as the param: neighbouring links spread the
   *  search forward, so `?project=` outlives the screen that meant it. */
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
