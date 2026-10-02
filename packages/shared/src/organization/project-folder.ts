/**
 * Where a project's files live: `home/projects/<name>`.
 *
 * The containing `projects` folder is one reserved name that never moves —
 * project folders at the drive root would collide with hand-made ones and the
 * reserved set would change on every rename.
 *
 * `metadata.project.folder` names the PARENT a project sits in, not its own
 * folder. The web app's `lib/project-tree.ts` groups on the same value, so nav
 * and files cannot disagree. Nothing writes the key yet.
 */

import { HOME_MOUNT_PATH } from "./home-mount";

/** The drive-root folder holding one folder per project. */
export const PROJECTS_FOLDER = "projects";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Farm · Loja BR` → `farm-loja-br`. Accents fold rather than drop, so `Ação`
 *  is `acao` and stays findable. */
export function folderNameFor(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface ProjectLike {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

/** The folder a person put this project IN, or null at the root of
 *  `projects/`. Module-private: only the browse path below reads it. */
function pinnedProjectFolder(project: ProjectLike): string | null {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const stored = isRecord(metadata.project) ? metadata.project : {};
  const pinned = stored.folder;
  return typeof pinned === "string" && pinned.trim() ? pinned.trim() : null;
}

/** A project's OWN folder, always derived from its title. Falls back to the id
 *  so a project titled only in emoji still has somewhere to put a file. */
export function projectFolderName(project: ProjectLike): string {
  return folderNameFor(project.title ?? "") || project.id;
}

/** The top of a project's tree inside the `home` volume, under its parent
 *  folder when it has one. */
export function projectFolderDir(project: ProjectLike): string {
  const parent = pinnedProjectFolder(project);
  return [PROJECTS_FOLDER, parent, projectFolderName(project)]
    .filter((segment): segment is string => !!segment)
    .join("/");
}

/** The same folder as a Library browse path. */
export function projectFolderPath(project: ProjectLike): string {
  return `${HOME_MOUNT_PATH}/${projectFolderDir(project)}`;
}

/** What every project folder holds, recreated when missing so the shape is
 *  the same in every project. */
export const PROJECT_SUBFOLDERS = [
  "Meetings",
  "Documents",
  "Research",
  "Reports",
  "Contracts",
] as const;

export const PROJECT_MEMORY_FILE = "memory.md";
