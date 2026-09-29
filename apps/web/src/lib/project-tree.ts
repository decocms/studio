/**
 * The sidebar's project tree: ONE split, read off the project rather than
 * asked for — a project with a repository is code, everything else is not.
 * Capability decides, label only describes.
 *
 * Both folders have to be occupied for either to appear, so an org that is all
 * code (or none) renders exactly the flat list it rendered before.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { hasRepository } from "./project-profile";

/** Which half a project fell in; the sidebar names them. */
export type ProjectFolderKind = "code" | "other";

export interface ProjectFolder {
  kind: ProjectFolderKind;
  projects: VirtualMCPEntity[];
}

export interface ProjectTree {
  /** Empty, or exactly the two — `code` first. */
  folders: ProjectFolder[];
  /** Every project, in the org's own order, when there is no tree to draw. */
  loose: VirtualMCPEntity[];
}

export function buildProjectTree(
  projects: readonly VirtualMCPEntity[],
): ProjectTree {
  const code: VirtualMCPEntity[] = [];
  const other: VirtualMCPEntity[] = [];
  for (const project of projects) {
    (hasRepository(project) ? code : other).push(project);
  }

  if (code.length === 0 || other.length === 0) {
    return { folders: [], loose: [...projects] };
  }

  return {
    folders: [
      { kind: "code", projects: code },
      { kind: "other", projects: other },
    ],
    loose: [],
  };
}
