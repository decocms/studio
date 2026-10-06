/**
 * What the project sidebar shows, from the org's folders and the member's own
 * pins and hides. Pure, so every rule below is a test.
 *
 * Where a project shows:
 *
 * 1. Pinned, when the member pinned it. Pinning wins over every hide.
 * 2. Else its folder (or loose), unless hidden; hiding beats a waiting task.
 *
 * The edit helpers at the bottom each return the next whole document, which
 * the hooks send as is.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type {
  ProjectFolder,
  SidebarPreferences,
} from "@decocms/shared/project-sidebar";

export interface SidebarFolderModel {
  folder: ProjectFolder;
  /** The projects to draw under it, folder order. */
  projects: VirtualMCPEntity[];
}

export interface ProjectSidebarModel {
  pinned: VirtualMCPEntity[];
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
}: {
  /** The org's projects, in the org's own order. */
  projects: readonly VirtualMCPEntity[];
  folders: readonly ProjectFolder[];
  preferences: SidebarPreferences;
}): ProjectSidebarModel {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const pinnedIds = new Set(preferences.pinned);
  const hiddenIds = new Set(preferences.hidden);
  const hiddenFolderIds = new Set(preferences.hiddenFolders);

  const folderOf = new Map<string, string>();
  for (const folder of folders) {
    for (const id of folder.projectIds) folderOf.set(id, folder.id);
  }
  const resolve = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((p): p is VirtualMCPEntity => !!p);

  const pinned = resolve(preferences.pinned);

  const visible = (p: VirtualMCPEntity) =>
    !pinnedIds.has(p.id) && !hiddenIds.has(p.id);

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
    folders: visibleFolders,
    loose: projects.filter((p) => !folderOf.has(p.id) && visible(p)),
    hiddenFolders,
    hidden: projects.filter((p) => hiddenIds.has(p.id) && !pinnedIds.has(p.id)),
  };
}

type ProjectState = "pinned" | "hidden";

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
