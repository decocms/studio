/**
 * Which of the org's cards a mount of the board is about.
 *
 * Scope narrows the INPUT, above `taskMatchesFilters` — not the `?repo=`
 * filter, whose exact match hid every repo-less card the moment a project was
 * picked (see the inverted tests in `filters-search.test.ts`).
 *
 * Separate from the component because the loading branch is the point: a scope
 * whose project has not resolved is LOADING, not empty. So is one whose org
 * project list has not landed: without the siblings, a repository this project
 * shares reads as its alone, and their unassigned cards would flash in.
 */

import {
  buildProjectIndex,
  tasksForProject,
  type AttributableTask,
} from "@/lib/project-index";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";

export function scopedBoardItems<T extends AttributableTask>({
  items,
  scopeId,
  project,
  projects,
  isLoading,
}: {
  /** Every card the org's board loaded. */
  items: readonly T[];
  /** The scoped project's id, or null on the org-wide board. */
  scopeId: string | null;
  /** That project, once the (non-blocking) list has resolved it. */
  project: VirtualMCPEntity | null;
  /** The org's projects, empty until the (non-blocking) list lands. */
  projects: readonly VirtualMCPEntity[];
  isLoading: boolean;
}): { items: T[]; isLoading: boolean } {
  if (!scopeId) return { items: [...items], isLoading };
  if (!project || projects.length === 0) return { items: [], isLoading: true };
  const all = projects.some((p) => p.id === project.id)
    ? projects
    : [...projects, project];
  return {
    items: tasksForProject(items, buildProjectIndex(all), scopeId),
    isLoading,
  };
}
