/**
 * Gives a project's folder its fixed shape: the subfolders every project has,
 * plus `memory.md`. Idempotent and additive: it only creates what is missing,
 * so files already in the folder are never touched and a deleted subfolder
 * comes back on the next call.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import {
  PROJECT_MEMORY_FILE,
  PROJECT_SUBFOLDERS,
  projectFolderDir,
} from "@decocms/shared/organization/project-folder";
import type { OrgFs } from "./org-fs";

interface ProjectLike {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

function memoryTemplate(title: string): string {
  return `# ${title}\n\nWhat to remember about this project: goals, decisions, people and context worth carrying into every chat.\n`;
}

/** Returns the folder's path inside the `home` volume. */
export async function ensureProjectFolder(
  orgFs: OrgFs,
  project: ProjectLike,
  actor: string,
): Promise<string> {
  const root = projectFolderDir(project);
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
      : orgFs.write(
          HOME_MOUNT_PATH,
          memoryPath,
          memoryTemplate(project.title?.trim() || "Memory"),
          { actor, contentType: "text/markdown" },
        ),
  ]);
  return root;
}
