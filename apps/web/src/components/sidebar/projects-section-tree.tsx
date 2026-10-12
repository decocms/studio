/** The sidebar's project tree (project-first nav); `buildProjectSidebar`
 *  decides placement, this draws it and wires the edits. */

import { useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  DotsHorizontal,
  EyeOff,
  Plus,
} from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@decocms/ui/components/context-menu.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import type { ProjectFolder } from "@decocms/shared/project-sidebar";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { tasksNeedingMe } from "@/components/org-home/daily-pulse";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { ProjectIcon } from "@/components/project-icon";
import { useCapability } from "@/hooks/use-capability";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useLeafRoutePath } from "@/hooks/use-destination-route";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import {
  useProjectSidebar,
  useUpdateProjectFolders,
  useUpdateSidebarPreferences,
} from "@/hooks/use-project-sidebar";
import { useProjectScope, useScopeId } from "@/hooks/use-project-scope";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { taskBoardItemsQueryOptions } from "@/hooks/use-task-board-items";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { FLAT_PROJECT_ROUTE } from "@/lib/flat-projects";
import { buildProjectIndex, projectForTask } from "@/lib/project-index";
import {
  buildProjectSidebar,
  createFolder,
  deleteFolder,
  moveProject,
  renameFolder,
  setFolderHidden,
  setProjectState,
} from "@/lib/project-sidebar-model";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { CustomizeSidebarDialog } from "./customize-sidebar-dialog";
import { FolderNameDialog, type FolderNameRequest } from "./folder-name-dialog";
import { SidebarNavRow } from "./nav-row";

/** What a right-click landed on, read from the row's `data-context-id`. */
type ContextTarget =
  | { kind: "project"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "none" };

function readContextTarget(event: MouseEvent): ContextTarget {
  const id = (event.target as HTMLElement)
    .closest("[data-context-id]")
    ?.getAttribute("data-context-id");
  if (id?.startsWith("project:")) return { kind: "project", id: id.slice(8) };
  if (id?.startsWith("folder:")) return { kind: "folder", id: id.slice(7) };
  return { kind: "none" };
}

/** Tasks waiting on the member, per project. Non-blocking: the counts fill in
 *  after the sidebar paints. */
function useWaitingByProject(
  projects: readonly VirtualMCPEntity[],
): Map<string, number> {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const { data: session } = authClient.useSession();
  const { data } = useQuery(taskBoardItemsQueryOptions(locator, studio));

  const counts = new Map<string, number>();
  if (!data) return counts;
  const index = buildProjectIndex(projects);
  for (const task of tasksNeedingMe(data.items, session?.user?.id)) {
    const project = projectForTask(task, index);
    if (project) counts.set(project.id, (counts.get(project.id) ?? 0) + 1);
  }
  return counts;
}

function SectionLabel({
  label,
  action,
}: {
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-6 items-center justify-between gap-2 px-2">
      <p className="font-medium text-xs text-muted-foreground">{label}</p>
      {action}
    </div>
  );
}

/** One project, wherever it sits. Tasks waiting on the member mark it like
 *  an unread channel, in every section: the name a weight up and a dot. */
function ProjectRow({
  project,
  isActive,
  onNavigate,
  waiting = 0,
  trailing,
  children,
}: {
  project: VirtualMCPEntity;
  isActive: boolean;
  onNavigate?: () => void;
  waiting?: number;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  const navigateToAgent = useNavigateToAgent();
  const waitingLabel =
    waiting > 0 ? t("sidebar.projects.waiting", { count: waiting }) : null;

  return (
    <SidebarNavRow
      icon={<ProjectIcon icon={project.icon} name={project.title} />}
      label={project.title}
      isActive={isActive}
      contextId={`project:${project.id}`}
      trailing={
        waitingLabel ? (
          <span
            title={waitingLabel}
            className="mr-1 size-2 rounded-full bg-warning group-hover/menu-item:invisible"
          />
        ) : (
          trailing
        )
      }
      className={cn(waitingLabel && "font-semibold")}
      ariaLabel={waitingLabel ? `${project.title}, ${waitingLabel}` : undefined}
      /** A button, not a link: these resolve a session, so the destination id
       *  is not knowable at render time. */
      onSelect={() => {
        track("sidebar_project_clicked");
        navigateToAgent(project.id);
        onNavigate?.();
      }}
    >
      {children}
    </SidebarNavRow>
  );
}

/** A folder as its own section, Discord-style: the name is a heading at the
 *  level of Pinned and Suggested, it folds like an accordion, and its projects
 *  sit flush under it. Open by default. */
function FolderSection({
  label,
  contextId,
  folderId,
  projects,
  selectedId,
  onNavigate,
  actions,
  waitingByProject,
}: {
  label: string;
  contextId?: string;
  /** Keys the persisted fold state; absent for the loose projects section. */
  folderId?: string;
  projects: VirtualMCPEntity[];
  selectedId: string | null;
  onNavigate?: () => void;
  waitingByProject: ReadonlyMap<string, number>;
  /** The header's own "⋯" and "+", the same on every section. */
  actions?: ReactNode;
}) {
  const { locator } = useProjectContext();
  const [open, setOpen] = useLocalStorage(
    LOCALSTORAGE_KEYS.sidebarSectionOpen(locator, folderId ?? "loose"),
    true,
  );
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col gap-1" data-context-id={contextId}>
      <div className="flex h-6 items-center justify-between gap-2 px-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((it) => !it)}
          className="group/folder flex min-w-0 items-center gap-1 rounded-md text-left"
        >
          <span className="truncate font-medium text-xs text-muted-foreground transition-colors group-hover/folder:text-sidebar-foreground">
            {label}
          </span>
          <Chevron size={12} className="shrink-0 text-muted-foreground" />
        </button>
        {actions}
      </div>
      {open && projects.length > 0 && (
        <SidebarMenu className="gap-1">
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              isActive={project.id === selectedId}
              onNavigate={onNavigate}
              waiting={waitingByProject.get(project.id)}
            />
          ))}
        </SidebarMenu>
      )}
    </div>
  );
}

export function SidebarProjectsTree({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const { granted: canManage } = useCapability("agents:manage");
  const { projects } = useProjectScope();
  const scopeId = useScopeId();
  const leafPath = useLeafRoutePath();
  const search = useSearch({ strict: false }) as { project?: string };
  const sidebar = useProjectSidebar();
  const waitingByProject = useWaitingByProject(projects);
  const updatePreferences = useUpdateSidebarPreferences();
  const updateFolders = useUpdateProjectFolders();
  const [target, setTarget] = useState<ContextTarget>({ kind: "none" });
  const [folderName, setFolderName] = useState<FolderNameRequest | null>(null);
  const [customizing, setCustomizing] = useState(false);

  /** ORG scope only: inside a project the sidebar is already about that
   *  project, and the picker is the control for leaving it. */
  if (scopeId || (projects.length === 0 && !canManage)) return null;

  const model = buildProjectSidebar({
    projects,
    folders: sidebar.folders,
    preferences: sidebar.preferences,
  });
  const hiddenCount =
    model.hidden.length +
    model.hiddenFolders.reduce((sum, f) => sum + f.projects.length, 0);
  /** Keyed on the ROUTE as well as the param: neighbouring links spread the
   *  search forward, so `?project=` outlives the screen that meant it. */
  const selectedId =
    leafPath === FLAT_PROJECT_ROUTE ? (search.project?.trim() ?? null) : null;

  const pin = (id: string, on: boolean) => {
    track(on ? "sidebar_project_pinned" : "sidebar_project_unpinned");
    updatePreferences.mutate((prefs) =>
      setProjectState(prefs, id, on ? "pinned" : null),
    );
  };
  const hide = (id: string, on: boolean) => {
    track(on ? "sidebar_project_hidden" : "sidebar_project_shown");
    updatePreferences.mutate((prefs) =>
      setProjectState(prefs, id, on ? "hidden" : null),
    );
  };
  const hideFolder = (id: string, on: boolean) =>
    updatePreferences.mutate((prefs) => setFolderHidden(prefs, id, on));
  const move = (projectId: string, folderId: string | null) =>
    updateFolders.mutate((folders) =>
      moveProject(folders, projectId, folderId),
    );
  const saveFolderName = (request: FolderNameRequest, name: string) => {
    if (request.kind === "rename") {
      updateFolders.mutate((folders) =>
        renameFolder(folders, request.folderId, name),
      );
      return;
    }
    const id = crypto.randomUUID();
    track("sidebar_folder_created");
    updateFolders.mutate((folders) => {
      const next = createFolder(folders, id, name);
      return request.projectId
        ? moveProject(next, request.projectId, id)
        : next;
    });
  };

  const pinnedIds = new Set(sidebar.preferences.pinned);
  const hiddenIds = new Set(sidebar.preferences.hidden);
  const folderOfTarget =
    target.kind === "project"
      ? sidebar.folders.find((f) => f.projectIds.includes(target.id))?.id
      : undefined;
  const targetFolder =
    target.kind === "folder"
      ? sidebar.folders.find((f) => f.id === target.id)
      : undefined;
  const customizeItem = (
    <ContextMenuItem onSelect={() => setCustomizing(true)}>
      {t("sidebar.projects.customize")}
    </ContextMenuItem>
  );

  /** Every section header's "⋯" and "+". "Projects" is the first grouping,
   *  the projects in no folder, so it gets the same controls as a folder. */
  const sectionActions = (folder: ProjectFolder | null) => (
    <span className="-mr-1 flex shrink-0 items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t(
              folder
                ? "sidebar.customize.folderOptions"
                : "sidebar.projects.more",
            )}
            title={t(
              folder
                ? "sidebar.customize.folderOptions"
                : "sidebar.projects.more",
            )}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <DotsHorizontal size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {folder && (
            <DropdownMenuItem onSelect={() => hideFolder(folder.id, true)}>
              {t("sidebar.projects.hideFolder")}
            </DropdownMenuItem>
          )}
          {folder && canManage && (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  setFolderName({
                    kind: "rename",
                    folderId: folder.id,
                    name: folder.name,
                  })
                }
              >
                {t("sidebar.projects.renameFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  updateFolders.mutate((folders) =>
                    deleteFolder(folders, folder.id),
                  )
                }
              >
                {t("sidebar.projects.deleteFolder")}
              </DropdownMenuItem>
            </>
          )}
          {folder && <DropdownMenuSeparator />}
          {canManage && (
            <DropdownMenuItem
              onSelect={() => setFolderName({ kind: "create" })}
            >
              {t("sidebar.projects.newFolder")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setCustomizing(true)}>
            {t("sidebar.projects.customize")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canManage && (
        <button
          type="button"
          aria-label={t("projects.home.newProject")}
          title={t("projects.home.newProject")}
          /* From a folder, the new project is filed in it. */
          onClick={() =>
            openNewProjectDialog(
              "sidebar",
              folder ? { onCreated: (id) => move(id, folder.id) } : undefined,
            )
          }
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Plus size={14} />
        </button>
      )}
    </span>
  );

  const projectRows = (list: VirtualMCPEntity[]) =>
    list.map((project) => (
      <ProjectRow
        key={project.id}
        project={project}
        isActive={project.id === selectedId}
        onNavigate={onNavigate}
        waiting={waitingByProject.get(project.id)}
      />
    ));

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="flex flex-col gap-4"
            data-tour={LAYOUT_TOUR_ANCHORS.projects}
            onContextMenu={(event) => setTarget(readContextTarget(event))}
          >
            {model.pinned.length > 0 && (
              <div className="flex flex-col gap-1">
                {!collapsed && (
                  <SectionLabel label={t("sidebar.projects.pinned")} />
                )}
                <SidebarMenu className="gap-1">
                  {projectRows(model.pinned)}
                </SidebarMenu>
              </div>
            )}

            {collapsed ? (
              <SidebarMenu className="gap-1">
                {projectRows([
                  ...model.folders.flatMap((f) => f.projects),
                  ...model.loose,
                ])}
                {/* Collapsed, the headings and their `+` are gone, so the
                    rail keeps the row it always had. */}
                {canManage && (
                  <SidebarNavRow
                    icon={<Plus size={16} />}
                    label={t("projects.home.newProject")}
                    onSelect={() => openNewProjectDialog("sidebar")}
                  />
                )}
              </SidebarMenu>
            ) : (
              <FolderSection
                label={t("sidebar.projects.heading")}
                projects={model.loose}
                selectedId={selectedId}
                onNavigate={onNavigate}
                waitingByProject={waitingByProject}
                actions={sectionActions(null)}
              />
            )}

            {!collapsed &&
              model.folders.map(({ folder, projects: inside }) => (
                <FolderSection
                  key={folder.id}
                  label={folder.name}
                  contextId={`folder:${folder.id}`}
                  folderId={folder.id}
                  projects={inside}
                  selectedId={selectedId}
                  onNavigate={onNavigate}
                  waitingByProject={waitingByProject}
                  actions={sectionActions(folder)}
                />
              ))}
            {hiddenCount > 0 && !collapsed && (
              <SidebarMenu>
                <SidebarNavRow
                  icon={<EyeOff size={16} />}
                  label={t("sidebar.projects.hiddenCount", {
                    count: hiddenCount,
                  })}
                  className="text-muted-foreground"
                  onSelect={() => setCustomizing(true)}
                />
              </SidebarMenu>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-52">
          {target.kind === "project" && (
            <>
              <ContextMenuItem
                onSelect={() => pin(target.id, !pinnedIds.has(target.id))}
              >
                {t(
                  pinnedIds.has(target.id)
                    ? "sidebar.projects.unpin"
                    : "sidebar.projects.pin",
                )}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => hide(target.id, !hiddenIds.has(target.id))}
              >
                {t(
                  hiddenIds.has(target.id)
                    ? "sidebar.projects.show"
                    : "sidebar.projects.hide",
                )}
              </ContextMenuItem>
              {canManage && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    {t("sidebar.projects.moveTo")}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-48">
                    {sidebar.folders.map((folder) => (
                      <ContextMenuItem
                        key={folder.id}
                        disabled={folder.id === folderOfTarget}
                        onSelect={() => move(target.id, folder.id)}
                      >
                        {folder.name}
                      </ContextMenuItem>
                    ))}
                    {folderOfTarget && (
                      <ContextMenuItem onSelect={() => move(target.id, null)}>
                        {t("sidebar.projects.noFolder")}
                      </ContextMenuItem>
                    )}
                    {sidebar.folders.length > 0 && <ContextMenuSeparator />}
                    <ContextMenuItem
                      onSelect={() =>
                        setFolderName({ kind: "create", projectId: target.id })
                      }
                    >
                      {t("sidebar.projects.newFolder")}
                    </ContextMenuItem>
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              <ContextMenuSeparator />
              {customizeItem}
            </>
          )}
          {target.kind === "folder" && targetFolder && (
            <>
              <ContextMenuItem
                onSelect={() => hideFolder(targetFolder.id, true)}
              >
                {t("sidebar.projects.hideFolder")}
              </ContextMenuItem>
              {canManage && (
                <>
                  <ContextMenuItem
                    onSelect={() =>
                      setFolderName({
                        kind: "rename",
                        folderId: targetFolder.id,
                        name: targetFolder.name,
                      })
                    }
                  >
                    {t("sidebar.projects.renameFolder")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() =>
                      updateFolders.mutate((folders) =>
                        deleteFolder(folders, targetFolder.id),
                      )
                    }
                  >
                    {t("sidebar.projects.deleteFolder")}
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              {canManage && (
                <ContextMenuItem
                  onSelect={() => setFolderName({ kind: "create" })}
                >
                  {t("sidebar.projects.newFolder")}
                </ContextMenuItem>
              )}
              {customizeItem}
            </>
          )}
          {target.kind === "none" && (
            <>
              {canManage && (
                <ContextMenuItem
                  onSelect={() => setFolderName({ kind: "create" })}
                >
                  {t("sidebar.projects.newFolder")}
                </ContextMenuItem>
              )}
              {customizeItem}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <FolderNameDialog
        request={folderName}
        onClose={() => setFolderName(null)}
        onSave={saveFolderName}
      />
      <CustomizeSidebarDialog
        open={customizing}
        onOpenChange={setCustomizing}
        projects={projects}
        folders={sidebar.folders}
        preferences={sidebar.preferences}
        canManage={canManage}
        onPin={pin}
        onHide={hide}
        onHideFolder={hideFolder}
        onMove={move}
        onRequestFolderName={setFolderName}
        onDeleteFolder={(id) =>
          updateFolders.mutate((folders) => deleteFolder(folders, id))
        }
      />
    </>
  );
}
