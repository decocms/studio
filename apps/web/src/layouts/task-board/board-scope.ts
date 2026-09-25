/**
 * Which of the org's cards a mount of the board is about.
 *
 * A project's home IS this board, so a project-scoped mount shows that
 * project's cards and nothing else. Scope narrows the INPUT — it is not the
 * `?repo=` filter, which is an exact string match and hid every repo-less card
 * the moment a project was picked (see the inverted tests in
 * `filters-search.test.ts`). Narrowing above `taskMatchesFilters` is also what
 * lets the reader's own filters compose INSIDE a project rather than fight it.
 *
 * Pure and separate from the component because the loading branch is the whole
 * point and is invisible on screen: a scope whose project has not resolved yet
 * is still LOADING, not empty. Collapsing it to "narrow once we have the
 * project" paints every other project's cards for a frame; collapsing it the
 * other way tells someone the project has no work before anyone has looked.
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
  isLoading,
}: {
  /** Every card the org's board loaded. */
  items: readonly T[];
  /** The scoped project's id, or null on the org-wide board. */
  scopeId: string | null;
  /** That project, once the (non-blocking) list has resolved it. */
  project: VirtualMCPEntity | null;
  isLoading: boolean;
}): { items: T[]; isLoading: boolean } {
  if (!scopeId) return { items: [...items], isLoading };
  if (!project) return { items: [], isLoading: true };
  return {
    items: tasksForProject(items, buildProjectIndex([project]), scopeId),
    isLoading,
  };
}
