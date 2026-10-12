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
 *
 * `metadata.projectFolderName` pins the project's OWN folder. The server sets
 * it the first time it gives the folder its shape, so a rename keeps the files
 * where they are, and its presence means that shape was already given.
 *
 * Both keys are client-writable and become write paths on the server, so a
 * value with an empty, `.`, `..` or encoded segment is ignored, never resolved.
 */

import { HOME_MOUNT_PATH } from "./home-mount";

/** The drive-root folder holding one folder per project. */
export const PROJECTS_FOLDER = "projects";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Acme · Loja BR` → `acme-loja-br`. Accents fold rather than drop, so `Ação`
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

/** A folder name the server can write under as-is: no traversal, no
 *  encoding, no separators. */
function isSafeSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && !/[/\\%]/.test(segment);
}

function metadataOf(project: ProjectLike): Record<string, unknown> {
  return isRecord(project.metadata) ? project.metadata : {};
}

/** The folder a person put this project IN, or null at the root of
 *  `projects/`. Module-private: only the browse path below reads it. */
function pinnedProjectFolder(project: ProjectLike): string | null {
  const metadata = metadataOf(project);
  const stored = isRecord(metadata.project) ? metadata.project : {};
  if (typeof stored.folder !== "string") return null;
  const segments = stored.folder
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0 || !segments.every(isSafeSegment)) return null;
  return segments.join("/");
}

/** The project's own folder name as the server pinned it, or null. */
export function pinnedProjectFolderName(project: ProjectLike): string | null {
  const pinned = metadataOf(project).projectFolderName;
  if (typeof pinned !== "string") return null;
  const name = pinned.trim();
  return name && isSafeSegment(name) ? name : null;
}

/** A project's OWN folder: pinned, or derived from its title. Falls back to
 *  the id so a project titled only in emoji still has somewhere to put a file. */
export function projectFolderName(project: ProjectLike): string {
  return (
    pinnedProjectFolderName(project) ??
    (folderNameFor(project.title ?? "") || project.id)
  );
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

/** Every project's folders, by a file's role so they fit any project. */
export const PROJECT_SUBFOLDERS = [
  "Documents",
  "Notes",
  "Work",
  "Delivered",
] as const;

export const PROJECT_MEMORY_FILE = "memory.md";
