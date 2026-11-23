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
  entryForFilter,
  tasksForProject,
  type AttributableTask,
  type ProjectIndex,
} from "@/lib/project-index";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskFilters } from "./task-filters-core";

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

/** The single project a filter value names, or null for none or several. */
function soleProject(filterId: string | null, index: ProjectIndex) {
  if (filterId === null) return null;
  const entry = entryForFilter(filterId, index);
  const [only, ...rest] = entry?.projects ?? [];
  return only && rest.length === 0 ? only.id : null;
}

/**
 * The Project filter value a project's own board shows: its picker option,
 * so the chip reads and checks like one picked on the org board.
 */
export function scopeFilterValue(scopeId: string, index: ProjectIndex): string {
  return (
    index.options.find((option) => soleProject(option.id, index) === scopeId)
      ?.id ?? scopeId
  );
}

/**
 * Where a filter change made on a project's board lands. Scope is the route,
 * not `?repo=`, so a different Project value is a navigation: to that
 * project's board when it names one project, else to the org's board.
 */
export function scopedFilterTarget(
  next: TaskFilters,
  scopeId: string,
  index: ProjectIndex,
):
  | { kind: "project"; projectId: string; filters: TaskFilters }
  | { kind: "org"; filters: TaskFilters } {
  const projectId = soleProject(next.project, index);
  return projectId
    ? { kind: "project", projectId, filters: { ...next, project: null } }
    : next.project === scopeId
      ? {
          kind: "project",
          projectId: scopeId,
          filters: { ...next, project: null },
        }
      : { kind: "org", filters: next };
}
