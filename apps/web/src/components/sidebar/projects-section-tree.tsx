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
  Folder,
  Pin02,
  Plus,
  XClose,
} from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
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
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { tasksNeedingMe } from "@/components/org-home/daily-pulse";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { ProjectIcon } from "@/components/project-icon";
import { useCapability } from "@/hooks/use-capability";
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
  type SidebarSuggestion,
} from "@/lib/project-sidebar-model";
import { buildProjectTree } from "@/lib/project-tree";
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

/** One project, wherever it sits. */
function ProjectRow({
  project,
  isActive,
  onNavigate,
  trailing,
  children,
}: {
  project: VirtualMCPEntity;
  isActive: boolean;
  onNavigate?: () => void;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const navigateToAgent = useNavigateToAgent();

  return (
    <SidebarNavRow
      icon={<ProjectIcon icon={project.icon} name={project.title} />}
      label={project.title}
      isActive={isActive}
      contextId={`project:${project.id}`}
      trailing={trailing}
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

/** A Suggested project: a badge for why, and Pin / Dismiss on hover. A task
 *  waiting on the member cannot be dismissed, only acted on or pinned. */
function SuggestedRow({
  suggestion,
  isActive,
  onNavigate,
  onPin,
  onDismiss,
}: {
  suggestion: SidebarSuggestion;
  isActive: boolean;
  onNavigate?: () => void;
  onPin: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const waiting = suggestion.reason === "needs-you";

  return (
    <ProjectRow
      project={suggestion.project}
      isActive={isActive}
      onNavigate={onNavigate}
      trailing={
        <span className="group-hover/menu-item:invisible">
          {waiting ? (
            <span
              title={t("sidebar.projects.waiting", {
                count: suggestion.waiting,
              })}
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-2xs font-medium text-warning-foreground tabular-nums"
            >
              {suggestion.waiting}
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">
              {t("sidebar.projects.newBadge")}
            </span>
          )}
        </span>
      }
    >
      {/* Beside the row's button, not in it: buttons cannot nest. */}
      <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center gap-0.5 group-hover/menu-item:flex group-data-[state=collapsed]/sidebar:!hidden">
        <RowAction label={t("sidebar.projects.pin")} onClick={onPin}>
          <Pin02 size={14} />
        </RowAction>
        {!waiting && (
          <RowAction label={t("sidebar.projects.dismiss")} onClick={onDismiss}>
            <XClose size={14} />
          </RowAction>
        )}
      </span>
    </ProjectRow>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      {children}
    </button>
  );
}

/** A folder and the projects in it. Open by default: a folder is a grouping,
 *  not a drawer. */
function FolderRow({
  label,
  contextId,
  projects,
  selectedId,
  onNavigate,
}: {
  label: string;
  contextId?: string;
  projects: VirtualMCPEntity[];
  selectedId: string | null;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <SidebarNavRow
      icon={
        <>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Folder size={16} />
        </>
      }
      label={label}
      contextId={contextId}
      className="text-sidebar-foreground/70"
      onSelect={() => setOpen((it) => !it)}
    >
      {open && projects.length > 0 && (
        <div className="mt-1 ml-4 border-sidebar-border border-l pl-2">
          <SidebarMenu className="gap-1">
            {projects.map((project) => (
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
    joinedAt: sidebar.joinedAt,
    waitingByProject,
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
  const dismiss = (id: string) => {
    track("sidebar_suggestion_dismissed");
    updatePreferences.mutate((prefs) =>
      setProjectState(prefs, id, "dismissed"),
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

  /** No real folders yet: keep the automatic Code / Other split. */
  const autoTree =
    sidebar.folders.length === 0 && !collapsed
      ? buildProjectTree(model.loose)
      : { folders: [], loose: model.loose };

  const projectRows = (list: VirtualMCPEntity[]) =>
    list.map((project) => (
      <ProjectRow
        key={project.id}
        project={project}
        isActive={project.id === selectedId}
        onNavigate={onNavigate}
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

            {model.suggested.length > 0 && (
              <div className="flex flex-col gap-1">
                {!collapsed && (
                  <SectionLabel label={t("sidebar.projects.suggested")} />
                )}
                <SidebarMenu className="gap-1">
                  {model.suggested.map((suggestion) => (
                    <SuggestedRow
                      key={suggestion.project.id}
                      suggestion={suggestion}
                      isActive={suggestion.project.id === selectedId}
                      onNavigate={onNavigate}
                      onPin={() => pin(suggestion.project.id, true)}
                      onDismiss={() => dismiss(suggestion.project.id)}
                    />
                  ))}
                </SidebarMenu>
              </div>
            )}

            <div className="flex flex-col gap-1">
              {!collapsed && (
                <SectionLabel
                  label={t("sidebar.projects.heading")}
                  action={
                    <span className="-mr-1 flex items-center gap-0.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={t("sidebar.projects.more")}
                            title={t("sidebar.projects.more")}
                            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                          >
                            <DotsHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {canManage && (
                            <DropdownMenuItem
                              onSelect={() => setFolderName({ kind: "create" })}
                            >
                              {t("sidebar.projects.newFolder")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => setCustomizing(true)}
                          >
                            {t("sidebar.projects.customize")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {canManage && (
                        <button
                          type="button"
                          aria-label={t("projects.home.newProject")}
                          title={t("projects.home.newProject")}
                          onClick={() => openNewProjectDialog("sidebar")}
                          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                        >
                          <Plus size={14} />
                        </button>
                      )}
                    </span>
                  }
                />
              )}
              <SidebarMenu className="gap-1">
                {collapsed
                  ? projectRows([
                      ...model.folders.flatMap((f) => f.projects),
                      ...model.loose,
                    ])
                  : model.folders.map(({ folder, projects: inside }) => (
                      <FolderRow
                        key={folder.id}
                        label={folder.name}
                        contextId={`folder:${folder.id}`}
                        projects={inside}
                        selectedId={selectedId}
                        onNavigate={onNavigate}
                      />
                    ))}
                {autoTree.folders.map((folder) => (
                  <FolderRow
                    key={folder.kind}
                    label={t(
                      folder.kind === "code"
                        ? "sidebar.projects.folderCode"
                        : "sidebar.projects.folderOther",
                    )}
                    projects={folder.projects}
                    selectedId={selectedId}
                    onNavigate={onNavigate}
                  />
                ))}
                {!collapsed && projectRows(autoTree.loose)}
                {hiddenCount > 0 && !collapsed && (
                  <SidebarNavRow
                    icon={<EyeOff size={16} />}
                    label={t("sidebar.projects.hiddenCount", {
                      count: hiddenCount,
                    })}
                    className="text-muted-foreground"
                    onSelect={() => setCustomizing(true)}
                  />
                )}
                {/* Collapsed, the heading and its `+` are gone, so the rail
                    keeps the row it always had. */}
                {canManage && collapsed && (
                  <SidebarNavRow
                    icon={<Plus size={16} />}
                    label={t("projects.home.newProject")}
                    onSelect={() => openNewProjectDialog("sidebar")}
                  />
                )}
              </SidebarMenu>
            </div>
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
