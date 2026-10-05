/**
 * The project sidebar's two layers.
 *
 * - Folders are ORG-WIDE structure: one list per organization, the same for
 *   every member. A project sits in at most one folder.
 * - Pins and hides are USER-WIDE: each member's own view of that structure.
 *
 * Each layer is one JSON document, written whole. Ids that point at deleted
 * projects or folders are dropped by readers, not swept.
 */

import { z } from "zod";

export const PROJECT_FOLDER_NAME_MAX = 60;
const MAX_FOLDERS = 100;
const MAX_IDS = 2000;

const ids = z.array(z.string().min(1)).max(MAX_IDS);

export const ProjectFolderSchema = z.object({
  /** Minted by the client; folders are written as a whole list. */
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(PROJECT_FOLDER_NAME_MAX),
  /** The folder's projects, in order. */
  projectIds: ids,
});
export type ProjectFolder = z.infer<typeof ProjectFolderSchema>;

/** In sidebar order. */
export const ProjectFoldersSchema = z
  .array(ProjectFolderSchema)
  .max(MAX_FOLDERS);

export const SidebarPreferencesSchema = z.object({
  /** In the member's pin order. */
  pinned: ids,
  hidden: ids,
  /** Decided on and shown in its place: cleared from Suggested, or unpinned
   *  or unhidden. Never "new" again. */
  dismissed: ids,
  /** Folders hidden whole, their projects with them. */
  hiddenFolders: ids,
});
export type SidebarPreferences = z.infer<typeof SidebarPreferencesSchema>;

export const EMPTY_SIDEBAR_PREFERENCES: SidebarPreferences = {
  pinned: [],
  hidden: [],
  dismissed: [],
  hiddenFolders: [],
};

export const SidebarSchema = z.object({
  folders: ProjectFoldersSchema,
  preferences: SidebarPreferencesSchema,
  /** When the member joined the org: a project created after this, with no
   *  decision from them, is new to them. ISO 8601. */
  joinedAt: z.string().nullable(),
});
export type Sidebar = z.infer<typeof SidebarSchema>;

/**
 * One folder per project and one entry per folder id, first wins. Applied on
 * write so a stale client cannot store a project in two folders.
 */
export function normalizeProjectFolders(
  folders: readonly ProjectFolder[],
): ProjectFolder[] {
  const seenFolders = new Set<string>();
  const placed = new Set<string>();
  const out: ProjectFolder[] = [];
  for (const folder of folders) {
    if (seenFolders.has(folder.id)) continue;
    seenFolders.add(folder.id);
    const projectIds = folder.projectIds.filter((id) => {
      if (placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    out.push({ ...folder, projectIds });
  }
  return out;
}

/** A project is in exactly one state for a member, so the lists never
 *  overlap; the last list a project appears in wins. */
export function normalizeSidebarPreferences(
  prefs: SidebarPreferences,
): SidebarPreferences {
  const state = new Map<string, "pinned" | "hidden" | "dismissed">();
  for (const id of prefs.pinned) state.set(id, "pinned");
  for (const id of prefs.hidden) state.set(id, "hidden");
  for (const id of prefs.dismissed) state.set(id, "dismissed");
  const of = (s: "pinned" | "hidden" | "dismissed", list: string[]) => [
    ...new Set(list.filter((id) => state.get(id) === s)),
  ];
  return {
    pinned: of("pinned", prefs.pinned),
    hidden: of("hidden", prefs.hidden),
    dismissed: of("dismissed", prefs.dismissed),
    hiddenFolders: [...new Set(prefs.hiddenFolders)],
  };
}

/** Org-wide folders changed; members re-read `SIDEBAR_GET`. */
export const PROJECT_FOLDERS_UPDATED_EVENT = "project-folders.updated";
