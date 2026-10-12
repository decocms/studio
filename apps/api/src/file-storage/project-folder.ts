/**
 * Gives a project's folder its fixed shape — the subfolders every project has,
 * plus `memory.md` — once. The first call pins the folder's name on the
 * project (`metadata.projectFolderName`), and a pinned project is never
 * scaffolded again: a rename keeps its files, and a folder a person deleted or
 * renamed stays that way.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import {
  PROJECT_MEMORY_FILE,
  PROJECT_SUBFOLDERS,
  pinnedProjectFolderName,
  projectFolderDir,
  projectFolderName,
} from "@decocms/shared/organization/project-folder";
import { OrgFsConflictError, type OrgFs } from "./org-fs";
import { notifyOrgFsChangeFromServer } from "./org-fs-notify";
import { normalizeFsPath } from "./org-fs-path";

interface ProjectLike {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

function memoryTemplate(title: string): string {
  return `# ${title}\n\nNotes worth keeping about this project: goals, decisions, people and context.\n`;
}

function withFolderName<T extends ProjectLike>(project: T, name: string): T {
  const metadata =
    typeof project.metadata === "object" && project.metadata !== null
      ? project.metadata
      : {};
  return { ...project, metadata: { ...metadata, projectFolderName: name } };
}

/** The project's folder name, suffixed past any folder another project owns.
 *  ponytail: two creates racing on one title can still pick the same name; a
 *  unique index on (org, folder) would make it exact. */
function unclaimedFolderName(
  project: ProjectLike,
  others: readonly ProjectLike[],
): string {
  const taken = new Set(others.map(projectFolderDir));
  const base = projectFolderName(project);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(projectFolderDir(withFolderName(project, name)))) {
      return name;
    }
  }
}

/** Create what the folder is missing. `memory.md` is written only when absent,
 *  so content that lands meanwhile is kept. */
export async function scaffoldProjectFolder(
  orgFs: OrgFs,
  root: string,
  title: string,
  actor: string,
): Promise<void> {
  const present = new Set(
    (await orgFs.listDir(HOME_MOUNT_PATH, root)).map((entry) => entry.path),
  );
  const missingDirs = PROJECT_SUBFOLDERS.map(
    (name) => `${root}/${name}`,
  ).filter((path) => !present.has(path));
  const memoryPath = `${root}/${PROJECT_MEMORY_FILE}`;

  await Promise.all([
    ...missingDirs.map((path) => orgFs.mkdir(HOME_MOUNT_PATH, path, { actor })),
    present.has(memoryPath)
      ? null
      : orgFs
          .write(HOME_MOUNT_PATH, memoryPath, memoryTemplate(title), {
            actor,
            contentType: "text/markdown",
            expect: { absent: true },
          })
          .catch((err) => {
            if (!(err instanceof OrgFsConflictError)) throw err;
          }),
  ]);
}

/**
 * Pin and scaffold a project's folder the first time. Returns the name to
 * persist as `metadata.projectFolderName`, or null when it is already pinned.
 */
export async function claimProjectFolder(params: {
  orgFs: OrgFs;
  organizationId: string;
  project: ProjectLike;
  /** Every project in the organization; the claimant may be among them. */
  projects: readonly ProjectLike[];
  /** The home volume is a repo-sync mirror, which drops direct writes. */
  homeIsSynced: boolean;
  actor: string;
}): Promise<string | null> {
  const { orgFs, organizationId, project, actor } = params;
  if (pinnedProjectFolderName(project)) return null;

  const name = unclaimedFolderName(
    project,
    params.projects.filter((p) => p.id !== project.id),
  );
  if (!params.homeIsSynced) {
    const root = normalizeFsPath(
      projectFolderDir(withFolderName(project, name)),
    );
    await scaffoldProjectFolder(
      orgFs,
      root,
      project.title?.trim() || "Memory",
      actor,
    );
    await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH);
  }
  return name;
}

/** Remove a project's folder with the project — only a pinned one, which this
 *  project alone owns. */
export async function deleteProjectFolder(
  orgFs: OrgFs,
  organizationId: string,
  project: ProjectLike,
  actor: string,
): Promise<void> {
  if (!pinnedProjectFolderName(project)) return;
  await orgFs.delete(HOME_MOUNT_PATH, projectFolderDir(project), { actor });
  await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH);
}
