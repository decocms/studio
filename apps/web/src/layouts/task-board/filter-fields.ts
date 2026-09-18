/**
 * Which filter fields a set of `TaskFilters` actually narrows by — the pure
 * half of the view controls.
 *
 * Kept separate from the components because two surfaces have to agree on it:
 * the applied-filters strip draws one chip per active field, and the filter
 * button's dot lights up when there is at least one. A field that narrows
 * nothing must appear in neither, and `project` is the one where "set" and
 * "narrows" come apart — an id the index cannot resolve lets every card
 * through (see `projectFilterNarrows`).
 */

import { projectFilterNarrows, type ProjectIndex } from "@/lib/project-index";
import type { TaskFilters } from "./task-filters-core";

/** Every field the filter menu offers, in the order both surfaces list it. */
const FILTER_FIELD_IDS = [
  "assignee",
  "priority",
  "due",
  "tags",
  "project",
] as const;

export type FilterFieldId = (typeof FILTER_FIELD_IDS)[number];

export function activeFilterFieldIds(
  filters: TaskFilters,
  index: ProjectIndex,
): FilterFieldId[] {
  return FILTER_FIELD_IDS.filter((id) => {
    switch (id) {
      case "assignee":
        return filters.assignee !== null;
      case "priority":
        return filters.priority !== null;
      case "due":
        return filters.due !== null;
      case "tags":
        return filters.tags.length > 0;
      case "project":
        return projectFilterNarrows(filters.project, index);
      default: {
        const exhaustive: never = id;
        return exhaustive;
      }
    }
  });
}

/** Clearing one chip leaves the others alone. */
export function withFieldCleared(
  filters: TaskFilters,
  id: FilterFieldId,
): TaskFilters {
  switch (id) {
    case "assignee":
      return { ...filters, assignee: null };
    case "priority":
      return { ...filters, priority: null };
    case "due":
      return { ...filters, due: null };
    case "tags":
      return { ...filters, tags: [] };
    case "project":
      return { ...filters, project: null };
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}
