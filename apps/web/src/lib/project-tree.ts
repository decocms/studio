/**
 * The sidebar's project tree: which folder each project sits in.
 *
 * ONE split, and it is read off the project rather than asked for: a project
 * with a repository is code and lands in one folder, everything else in the
 * other. Capability decides, label only describes — the same rule the rest of
 * projects answers to.
 *
 * This replaces a richer rule (a folder someone pinned on
 * `metadata.project.folder`, plus one per repository OWNER shared by two or
 * more projects). Nothing writes the pinned key, so half of that rule was a
 * folder nobody could make, and the other half grouped by an accident of who
 * owns the GitHub org. The split that is true today is "does this project have
 * code in it", because that is what changes what you can do with it.
 *
 * Both folders have to be occupied for either to appear: a single folder over
 * every project is a lid that says nothing the heading above it did not, and
 * an org that is all code — or none — renders EXACTLY the flat list it
 * rendered before. The tree appears when there IS a tree.
 *
 * Pure, so the rule is a thing a unit test can hold.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { hasRepository } from "./project-profile";

/** Which half a project fell in. The sidebar names them; this module does not
 *  hold copy. */
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
