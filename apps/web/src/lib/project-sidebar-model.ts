/**
 * What the project sidebar shows, from the org's folders and the member's own
 * pins and hides. Pure, so every rule below is a test.
 *
 * Where a project shows:
 *
 * 1. Pinned, when the member pinned it. Pinning wins over every hide.
 * 2. Else its folder (or loose), unless hidden; hiding beats a waiting task.
 * 3. Suggested until cleared: waiting tasks (also in folder) or new (instead).
 *
 * The edit helpers at the bottom each return the next whole document, which
 * the hooks send as is.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type {
  ProjectFolder,
  SidebarPreferences,
} from "@decocms/shared/project-sidebar";

/** "New to you" stops suggesting after this many, newest first. */
const MAX_NEW_SUGGESTIONS = 5;

export type SuggestionReason = "needs-you" | "new";

export interface SidebarSuggestion {
  project: VirtualMCPEntity;
  reason: SuggestionReason;
  /** Waiting tasks, for the badge. Zero for a "new" suggestion. */
  waiting: number;
}

export interface SidebarFolderModel {
  folder: ProjectFolder;
  /** The projects to draw under it, folder order. */
  projects: VirtualMCPEntity[];
}

export interface ProjectSidebarModel {
  pinned: VirtualMCPEntity[];
  suggested: SidebarSuggestion[];
  /** Visible folders, org order. An empty folder still shows: it is a place
   *  to move projects into. */
  folders: SidebarFolderModel[];
  /** Projects in no folder. */
  loose: VirtualMCPEntity[];
  /** Folders this member hid, with all their projects. */
  hiddenFolders: SidebarFolderModel[];
  /** Projects this member hid one by one. */
  hidden: VirtualMCPEntity[];
}

export function buildProjectSidebar({
  projects,
  folders,
  preferences,
  joinedAt,
  waitingByProject,
}: {
  /** The org's projects, in the org's own order. */
  projects: readonly VirtualMCPEntity[];
  folders: readonly ProjectFolder[];
  preferences: SidebarPreferences;
  joinedAt: string | null;
  /** Tasks waiting on this member, per project id. */
  waitingByProject: ReadonlyMap<string, number>;
}): ProjectSidebarModel {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const pinnedIds = new Set(preferences.pinned);
  const hiddenIds = new Set(preferences.hidden);
  const dismissedIds = new Set(preferences.dismissed);
  const hiddenFolderIds = new Set(preferences.hiddenFolders);

  const folderOf = new Map<string, string>();
  for (const folder of folders) {
    for (const id of folder.projectIds) folderOf.set(id, folder.id);
  }
  const inHiddenFolder = (id: string) => {
    const folderId = folderOf.get(id);
    return folderId !== undefined && hiddenFolderIds.has(folderId);
  };
  const resolve = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((p): p is VirtualMCPEntity => !!p);

  const pinned = resolve(preferences.pinned);

  const hidden = (id: string) => hiddenIds.has(id) || inHiddenFolder(id);
  const needsYou: SidebarSuggestion[] = projects
    .filter(
      (p) =>
        !pinnedIds.has(p.id) &&
        !dismissedIds.has(p.id) &&
        !hidden(p.id) &&
        (waitingByProject.get(p.id) ?? 0) > 0,
    )
    .map((project) => ({
      project,
      reason: "needs-you" as const,
      waiting: waitingByProject.get(project.id) ?? 0,
    }))
    .sort((a, b) => b.waiting - a.waiting);
  const needsYouIds = new Set(needsYou.map((s) => s.project.id));

  const joined = joinedAt ? Date.parse(joinedAt) : Number.NaN;
  const fresh: SidebarSuggestion[] = projects
    .filter(
      (p) =>
        !Number.isNaN(joined) &&
        Date.parse(p.created_at) > joined &&
        !pinnedIds.has(p.id) &&
        !dismissedIds.has(p.id) &&
        !hidden(p.id) &&
        !needsYouIds.has(p.id),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_NEW_SUGGESTIONS)
    .map((project) => ({ project, reason: "new" as const, waiting: 0 }));

  const suggested = [...needsYou, ...fresh];
  /** Only a "new" suggestion takes the project out of its folder. */
  const elsewhere = new Set([...pinnedIds, ...fresh.map((s) => s.project.id)]);
  const visible = (p: VirtualMCPEntity) =>
    !elsewhere.has(p.id) && !hiddenIds.has(p.id);

  const visibleFolders: SidebarFolderModel[] = [];
  const hiddenFolders: SidebarFolderModel[] = [];
  for (const folder of folders) {
    const inside = resolve(folder.projectIds).filter(visible);
    (hiddenFolderIds.has(folder.id) ? hiddenFolders : visibleFolders).push({
      folder,
      projects: inside,
    });
  }

  return {
    pinned,
    suggested,
    folders: visibleFolders,
    loose: projects.filter((p) => !folderOf.has(p.id) && visible(p)),
    hiddenFolders,
    hidden: projects.filter((p) => hiddenIds.has(p.id) && !elsewhere.has(p.id)),
  };
}

type ProjectState = "pinned" | "hidden" | "dismissed";

/** Put a project in one state (or none), out of the other two. */
export function setProjectState(
  prefs: SidebarPreferences,
  projectId: string,
  state: ProjectState | null,
): SidebarPreferences {
  const without = (list: string[]) => list.filter((id) => id !== projectId);
  const next = {
    ...prefs,
    pinned: without(prefs.pinned),
    hidden: without(prefs.hidden),
    dismissed: without(prefs.dismissed),
  };
  if (state) next[state] = [...next[state], projectId];
  return next;
}

export function setFolderHidden(
  prefs: SidebarPreferences,
  folderId: string,
  hidden: boolean,
): SidebarPreferences {
  const rest = prefs.hiddenFolders.filter((id) => id !== folderId);
  return { ...prefs, hiddenFolders: hidden ? [...rest, folderId] : rest };
}

export function createFolder(
  folders: readonly ProjectFolder[],
  id: string,
  name: string,
): ProjectFolder[] {
  return [...folders, { id, name, projectIds: [] }];
}

export function renameFolder(
  folders: readonly ProjectFolder[],
  folderId: string,
  name: string,
): ProjectFolder[] {
  return folders.map((f) => (f.id === folderId ? { ...f, name } : f));
}

/** Its projects become loose; nothing is deleted with it. */
export function deleteFolder(
  folders: readonly ProjectFolder[],
  folderId: string,
): ProjectFolder[] {
  return folders.filter((f) => f.id !== folderId);
}

/** Into a folder (at its end), or out of every folder with `null`. */
export function moveProject(
  folders: readonly ProjectFolder[],
  projectId: string,
  folderId: string | null,
): ProjectFolder[] {
  return folders.map((f) => {
    const rest = f.projectIds.filter((id) => id !== projectId);
    return {
      ...f,
      projectIds: f.id === folderId ? [...rest, projectId] : rest,
    };
  });
}
