/**
 * Where a project's files live.
 *
 * The product is one computer: the organization is the drive and a project is a
 * folder in it. So "open the project, then open its files" has to land
 * somewhere real — `home/projects/<name>` — rather than showing the whole org's
 * drive again under a project's chrome.
 *
 * The containing `projects` folder is deliberate. Project folders at the drive
 * root would collide with the folders people make by hand, and the set of names
 * to reserve would change every time a project is renamed. One reserved name
 * that never moves is the only version of this that stays true.
 *
 * `metadata.project.folder` names the PARENT a project sits in, not the
 * project's own folder — `home/projects/clientes/farm-loja-vtex`. One key, one
 * meaning: "which folder is this project in". The sidebar's tree
 * (`lib/project-tree.ts`) groups on exactly that value, so the folder you see
 * in the nav and the folder the files live in cannot disagree; reading it as
 * the project's OWN name is what made them, and the head's folder chip is where
 * it showed.
 *
 * Nothing writes the key yet — the same seam as `projectReportConnectionId`.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";

/** The drive-root folder holding one folder per project. */
export const PROJECTS_FOLDER = "projects";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A project title as a folder name: `Farm · Loja BR` → `farm-loja-br`.
 *
 * Accents are folded rather than dropped, so `Ação` is `acao` and not `ao` —
 * a Brazilian storefront team names projects in Portuguese, and a folder whose
 * name lost its vowels is not findable by the person who named it.
 */
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

/** The folder a person put this project IN, or null when it sits at the root
 *  of `projects/`. Module-private: the sidebar's tree used to read it too, and
 *  now splits on code vs not (`lib/project-tree.ts`), so the browse path below
 *  is the only thing this answers. */
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

/** The Library browse path that is the top of a project's tree, under its
 *  parent folder when it has one. */
export function projectFolderPath(project: ProjectLike): string {
  const parent = pinnedProjectFolder(project);
  const segments = [PROJECTS_FOLDER, parent, projectFolderName(project)].filter(
    (segment): segment is string => !!segment,
  );
  return `${HOME_MOUNT_PATH}/${segments.join("/")}`;
}
