import { useState } from "react";
import type { Sprint } from "@decocms/shared/sprints";
import {
  EMPTY_FILTERS,
  TaskFiltersBar,
  type TaskFilters,
} from "@/layouts/task-board/task-filters";
import { buildProjectIndex } from "@/lib/project-index";

/**
 * Fixed sprints, in the order the board is expected to offer them: what's
 * running, then what's next, then history. Fixed dates rather than a clock
 * anchor — a sprint's state is now its own field, so nothing here depends on
 * the day the suite runs.
 */
const SPRINTS: Sprint[] = [
  {
    id: "sprint_active",
    name: "Sprint 12",
    state: "active",
    startsAt: "2026-03-02T00:00:00.000Z",
    endsAt: "2026-03-15T00:00:00.000Z",
  },
  {
    id: "sprint_next",
    name: "Sprint 13",
    state: "future",
    startsAt: "2026-03-16T00:00:00.000Z",
    endsAt: "2026-03-29T00:00:00.000Z",
  },
  {
    id: "sprint_undated",
    name: "Sprint 14",
    state: "future",
    startsAt: null,
    endsAt: null,
  },
  {
    id: "sprint_past",
    name: "Sprint 11",
    state: "closed",
    startsAt: "2026-02-16T00:00:00.000Z",
    endsAt: "2026-03-01T00:00:00.000Z",
  },
];

/**
 * CT surface for the board's sprint filter: the real `TaskFiltersBar` with only
 * the sprint control populated. Radix menus open on pointerdown and portal their
 * content, which the happy-dom unit tier never opens — so the picker's row
 * layout is asserted here, in a real browser.
 */
export function SprintFilterHarness() {
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  return (
    <div className="w-[560px] bg-background p-6">
      <TaskFiltersBar
        filters={filters}
        members={[]}
        tags={[]}
        index={buildProjectIndex([])}
        sprints={SPRINTS}
        onChange={setFilters}
        onOpenBoardSettings={() => {}}
      />
      <pre data-testid="sprint">{JSON.stringify(filters.sprint)}</pre>
    </div>
  );
}
